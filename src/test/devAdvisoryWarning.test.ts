import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface ScriptResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** An advisory as the registry's bulk advisory endpoint returns it. */
interface RegistryAdvisory {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly severity: string;
  readonly vulnerable_versions: string;
}

/** What the fake registry answers to advisory requests; `undefined` sends an HTTP 500. */
type AdvisoryAnswer = Record<string, RegistryAdvisory[]> | undefined;

const SCRIPT = resolve("scripts/warn-dev-advisories.mjs");
const AUDIT_TIMEOUT_MS = 30_000;
const PACKAGE = "left-pad";
const ADVISORY_URL = "https://github.com/advisories/GHSA-test-test-test";
/** npm reads the vulnerable package's published versions to decide which of them an advisory affects. */
const PACKUMENT = {
  name: PACKAGE,
  "dist-tags": { latest: "2.0.0" },
  versions: { "1.0.0": { name: PACKAGE, version: "1.0.0" }, "2.0.0": { name: PACKAGE, version: "2.0.0" } },
};

let directory: string;
let server: Server;
let answer: AdvisoryAnswer;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "jw-differ-dev-audit-"));
  writeProject();
  answer = {};
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const reply = request.url === `/${PACKAGE}` ? PACKUMENT : answer;
      response.statusCode = reply === undefined ? 500 : 200;
      response.setHeader("content-type", "application/json");
      response.end(reply === undefined ? "unavailable" : JSON.stringify(reply));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});

afterEach(async () => {
  await new Promise((done) => server.close(done));
  rmSync(directory, { recursive: true, force: true });
});

/** A project whose only locked package is a dev dependency on `left-pad@1.0.0`. */
function writeProject(): void {
  const devDependencies = { [PACKAGE]: "1.0.0" };
  const lockfile = {
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", devDependencies },
      [`node_modules/${PACKAGE}`]: { version: "1.0.0", dev: true },
    },
  };
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture", devDependencies }));
  writeFileSync(join(directory, "package-lock.json"), JSON.stringify(lockfile));
}

function advisory(severity: string, title = "left-pad pads too much"): RegistryAdvisory {
  return { id: 1, url: ADVISORY_URL, title, severity, vulnerable_versions: "<2.0.0" };
}

function runWarning(): Promise<ScriptResult> {
  const { port } = server.address() as AddressInfo;
  // Empty npmrc files keep the machine's npm settings, such as omit=dev or a proxy, out of the audit; npm refuses to
  // load one file as both.
  const userConfig = join(directory, "user.npmrc");
  const globalConfig = join(directory, "global.npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  const env = {
    ...process.env,
    npm_config_registry: `http://127.0.0.1:${port}/`,
    npm_config_cache: join(directory, ".npm-cache"),
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
  };
  const child = spawn(process.execPath, [SCRIPT, directory], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((done) => child.on("close", (status) => done({ status, stdout, stderr })));
}

describe("dev tool advisory warning", () => {
  it("passes without warnings when the audit finds no advisories", async () => {
    const result = await runWarning();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm audit: 0 high or critical advisories");
    expect(result.stdout).not.toContain("::warning");
  }, AUDIT_TIMEOUT_MS);

  it("passes and warns of each high advisory by package, title, range and link", async () => {
    answer = { [PACKAGE]: [advisory("high")] };

    const result = await runWarning();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `::warning title=Dev tool advisory (not shipped)::${PACKAGE}: left-pad pads too much (high, <2.0.0) ${ADVISORY_URL}`,
    );
  }, AUDIT_TIMEOUT_MS);

  it("does not warn of advisories below high severity", async () => {
    answer = { [PACKAGE]: [advisory("moderate")] };

    const result = await runWarning();

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("::warning");
  }, AUDIT_TIMEOUT_MS);

  it("escapes line breaks in advisory text so they cannot start another workflow command", async () => {
    answer = { [PACKAGE]: [advisory("critical", "bad\n::error::injected")] };

    const result = await runWarning();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bad%0A::error::injected");
    expect(result.stdout).not.toMatch(/^::error::/m);
  }, AUDIT_TIMEOUT_MS);

  it("fails when the audit itself fails, such as on a registry error", async () => {
    answer = undefined;

    const result = await runWarning();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm audit returned no vulnerability report.");
    expect(result.stdout).not.toContain("::warning");
  }, AUDIT_TIMEOUT_MS);
});
