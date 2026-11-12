import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { HISTORY_GIT_OUTPUT_LIMIT_BYTES, HistoryGitError, runHistoryGit } from "../git/historyGitCommand";
import type {
  HistoryGitOptions,
  HistoryGitResult,
  HistoryGitSpawnOptions,
  SpawnHistoryGit,
} from "../git/historyGitCommand";
import {
  captureRepositoryState,
  commitFiles,
  createHistoryRepository,
  disposeHistoryRepository,
  fixtureGitEnvironment,
  runFixtureGit,
} from "./gitHistoryFixture";
import type { HistoryRepositoryFixture } from "./gitHistoryFixture";

/** Bytes that break naive text transport: NUL, CRLF, a lone CR, invalid UTF-8 and no final newline. */
const AWKWARD_BYTES = Buffer.from([0x61, 0x00, 0x62, 0x0d, 0x0a, 0x0a, 0x0d, 0xff, 0xfe, 0x00, 0x63]);

interface FakeChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly emitter: EventEmitter;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
}

function createFakeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  const child = Object.assign(emitter, { stdin: new PassThrough(), stdout, stderr, kill });
  return { process: child as unknown as ChildProcessWithoutNullStreams, emitter, stdout, stderr, kill };
}

interface StartedRun {
  readonly promise: Promise<HistoryGitResult>;
  readonly spawnProcess: Mock<SpawnHistoryGit>;
}

/** Starts a run on `child` and waits until it is spawned, so emitted events reach the run's listeners. */
async function startRun(child: FakeChild, options: Omit<HistoryGitOptions, "spawnProcess">): Promise<StartedRun> {
  const spawnProcess = vi.fn<SpawnHistoryGit>(() => child.process);
  const promise = runHistoryGit({ ...options, spawnProcess });
  promise.catch(() => undefined);
  await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalled());
  return { promise, spawnProcess };
}

async function expectGitError(promise: Promise<unknown>): Promise<HistoryGitError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HistoryGitError);
  return error as HistoryGitError;
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  const timeout = new Promise((resolve) => setTimeout(resolve, 20, marker));
  const winner = await Promise.race([promise.catch(() => undefined), timeout]);
  return winner === marker;
}

describe("runHistoryGit with a real repository", () => {
  let fixture: HistoryRepositoryFixture;

  beforeEach(() => {
    fixture = createHistoryRepository();
  });

  afterEach(() => {
    disposeHistoryRepository(fixture);
  });

  const inFixture = (): { readonly cwd: string; readonly env: NodeJS.ProcessEnv } => ({
    cwd: fixture.root,
    env: fixtureGitEnvironment(),
  });

  it("round-trips binary stdin through hash-object", async () => {
    const args = ["hash-object", "-w", "--stdin"];
    const hashed = await runHistoryGit({ ...inFixture(), args, stdin: AWKWARD_BYTES });
    const oid = hashed.stdout.toString("utf8").trim();

    const blob = await runHistoryGit({ ...inFixture(), args: ["cat-file", "blob", oid] });

    expect(blob.stdout.equals(AWKWARD_BYTES)).toBe(true);
  });

  it("matches the object ID Git computes for the same file bytes", async () => {
    const oid = commitAwkwardFile(fixture.root);

    const hashed = await runHistoryGit({ ...inFixture(), args: ["hash-object", "--stdin"], stdin: AWKWARD_BYTES });

    expect(hashed.stdout.toString("utf8")).toBe(`${oid}\n`);
  });

  it("preserves embedded newlines and NUL separators in stdout", async () => {
    commitFiles(fixture.root, {
      message: "odd names",
      changes: [
        { kind: "write", path: "line\nbreak.txt", content: "x" },
        { kind: "write", path: "plain.txt", content: "y" },
      ],
    });

    const listing = await runHistoryGit({ ...inFixture(), args: ["ls-files", "-z"] });

    expect(listing.stdout.toString("utf8")).toBe("line\nbreak.txt\0plain.txt\0");
  });

  it("rejects an invalid revision as a Git failure with stderr", async () => {
    const promise = runHistoryGit({
      ...inFixture(),
      args: ["rev-parse", "--verify", "--end-of-options", "no-such-ref^{commit}"],
    });

    const error = await expectGitError(promise);
    expect(error.kind).toBe("failed");
    expect(error.exitCode).toBe(128);
    expect(error.message).toContain("rev-parse");
    expect(error.stderr.length).toBeGreaterThan(0);
  });

  it("resolves an exit code the caller explicitly allows", async () => {
    commitFiles(fixture.root, { message: "one", changes: [{ kind: "write", path: "a.txt", content: "a\n" }] });
    runFixtureGit(fixture.root, ["checkout", "-q", "-b", "side"]);
    commitFiles(fixture.root, { message: "two", changes: [{ kind: "write", path: "a.txt", content: "b\n" }] });

    const result = await runHistoryGit({
      ...inFixture(),
      args: ["diff", "--quiet", "main", "side", "--"],
      allowedExitCodes: [0, 1],
    });

    expect(result.exitCode).toBe(1);
  });

  it("reports a missing Git executable when PATH cannot find it", async () => {
    const promise = runHistoryGit({ cwd: fixture.root, args: ["status"], env: { PATH: fixture.directory } });

    const error = await expectGitError(promise);
    expect(error.kind).toBe("missingGit");
  });

  it("reports a missing working directory as a failure rather than missing Git", async () => {
    const promise = runHistoryGit({ cwd: `${fixture.directory}/gone`, args: ["status"] });

    const error = await expectGitError(promise);
    expect(error.kind).toBe("failed");
  });

  it("resolves when Git exits without reading large stdin", async () => {
    commitAwkwardFile(fixture.root);
    const stdin = Buffer.alloc(4 * 1024 * 1024, 0x61);

    const result = await runHistoryGit({ ...inFixture(), args: ["rev-parse", "HEAD"], stdin });

    expect(result.exitCode).toBe(0);
  });

});

describe("runHistoryGit with a simulated child process", () => {
  const directory = os.tmpdir();

  it("reports a missing Git executable distinctly", async () => {
    const child = createFakeChild();
    const { promise } = await startRun(child, { cwd: directory, args: ["status"] });

    child.emitter.emit("error", Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));

    const error = await expectGitError(promise);
    expect(error.kind).toBe("missingGit");
  });

  it("rejects a synchronous spawn failure as a Git failure", async () => {
    const spawnProcess: SpawnHistoryGit = () => {
      throw new TypeError("The argument 'args[1]' must be a string without null bytes");
    };

    const error = await expectGitError(runHistoryGit({ cwd: directory, args: ["log", "a\0b"], spawnProcess }));

    expect(error.kind).toBe("failed");
  });

  it("kills the child on abort and settles only after it terminates", async () => {
    const child = createFakeChild();
    const controller = new AbortController();
    const { promise } = await startRun(child, { cwd: directory, args: ["log"], signal: controller.signal });

    controller.abort();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await isPending(promise)).toBe(true);
    child.emitter.emit("close", null, "SIGTERM");
    const error = await expectGitError(promise);
    expect(error.kind).toBe("cancelled");
  });

  it("does not start Git when the signal is already aborted", async () => {
    const spawnProcess = vi.fn<SpawnHistoryGit>();
    const controller = new AbortController();
    controller.abort();

    const promise = runHistoryGit({ cwd: directory, args: ["log"], signal: controller.signal, spawnProcess });

    const error = await expectGitError(promise);
    expect(error.kind).toBe("cancelled");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("kills the child when output exceeds the limit and settles only after it terminates", async () => {
    const child = createFakeChild();
    const { promise } = await startRun(child, { cwd: directory, args: ["log"] });

    child.stdout.write(Buffer.alloc(HISTORY_GIT_OUTPUT_LIMIT_BYTES + 1));
    await new Promise((resolve) => setImmediate(resolve));

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await isPending(promise)).toBe(true);
    child.emitter.emit("close", null, "SIGTERM");
    const error = await expectGitError(promise);
    expect(error.kind).toBe("outputLimitExceeded");
  });

  it("starts Git in the temporary directory and passes the requested directory as -C", async () => {
    const child = createFakeChild();
    const requested = fs.mkdtempSync(path.join(os.tmpdir(), "differ-cwd-"));
    try {
      const { promise, spawnProcess } = await startRun(child, { cwd: requested, args: ["log", "-1"] });
      child.emitter.emit("close", 0, null);
      await promise;

      expect(spawnProcess.mock.calls[0]?.[0]).toEqual(["-C", requested, "log", "-1"]);
      expect(spawnProcess.mock.calls[0]?.[1].cwd).toBe(os.tmpdir());
    } finally {
      fs.rmSync(requested, { recursive: true, force: true });
    }
  });

  it("inherits the environment with replace objects and lazy fetching disabled by default", async () => {
    const child = createFakeChild();
    const { promise, spawnProcess } = await startRun(child, { cwd: directory, args: ["log"] });

    child.emitter.emit("close", 0, null);
    await promise;

    const options = spawnProcess.mock.calls[0]?.[1] as HistoryGitSpawnOptions;
    expect(options.env["GIT_NO_REPLACE_OBJECTS"]).toBe("1");
    expect(options.env["GIT_NO_LAZY_FETCH"]).toBe("1");
    expect(options.env["PATH"]).toBe(process.env["PATH"]);
  });

  it("drops inherited repository-location and configuration-injection variables by default", async () => {
    const injected: Readonly<Record<string, string>> = {
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/elsewhere/index",
      GIT_OBJECT_DIRECTORY: "/elsewhere/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/elsewhere/alternates",
      GIT_COMMON_DIR: "/elsewhere/common",
      GIT_NAMESPACE: "other",
      GIT_CEILING_DIRECTORIES: "/",
      GIT_CONFIG_PARAMETERS: "'core.pager'='evil'",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "evil",
    };
    Object.entries(injected).forEach(([name, value]) => vi.stubEnv(name, value));
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/home/user/.gitconfig");
    const child = createFakeChild();

    try {
      const { promise, spawnProcess } = await startRun(child, { cwd: directory, args: ["log"] });
      child.emitter.emit("close", 0, null);
      await promise;

      const { env } = spawnProcess.mock.calls[0]?.[1] as HistoryGitSpawnOptions;
      Object.keys(injected).forEach((name) => expect(env[name]).toBeUndefined());
      expect(env["GIT_CONFIG_GLOBAL"]).toBe("/home/user/.gitconfig");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes a caller-supplied environment verbatim", async () => {
    const child = createFakeChild();
    const env = { GIT_CONFIG_NOSYSTEM: "1" };
    const { promise, spawnProcess } = await startRun(child, { cwd: directory, args: ["write-tree"], env });

    child.emitter.emit("close", 0, null);
    await promise;

    expect(spawnProcess.mock.calls[0]?.[1]).toEqual({ cwd: os.tmpdir(), env });
  });

  it("redacts internal paths from the message but keeps them in the detail", async () => {
    const child = createFakeChild();
    const redactedPaths = ["/tmp/replay-123"];
    const { promise } = await startRun(child, { cwd: directory, args: ["apply", "--cached"], redactedPaths });

    child.stderr.write("error: /tmp/replay-123/index: corrupt");
    await new Promise((resolve) => setImmediate(resolve));
    child.emitter.emit("close", 1, null);

    const error = await expectGitError(promise);
    expect(error.message).not.toContain("/tmp/replay-123");
    expect(error.message).toContain("<temporary repository>/index");
    expect(error.detail).toContain("/tmp/replay-123");
  });
});

describe("captureRepositoryState", () => {
  let fixture: HistoryRepositoryFixture;

  beforeEach(() => {
    fixture = createHistoryRepository();
    commitFiles(fixture.root, { message: "base", changes: [{ kind: "write", path: "a.txt", content: "a\n" }] });
  });

  afterEach(() => {
    disposeHistoryRepository(fixture);
  });

  it.each([
    ["an untracked file", (root: string) => fs.writeFileSync(path.join(root, "new.txt"), "n")],
    ["a staged change", (root: string) => runFixtureGit(root, ["update-index", "--chmod=+x", "a.txt"])],
    ["a ref move", (root: string) => runFixtureGit(root, ["branch", "other"])],
    ["a detached HEAD", (root: string) => runFixtureGit(root, ["checkout", "-q", "--detach"])],
  ])("detects %s", (_name, mutate) => {
    const before = captureRepositoryState(fixture.root);

    mutate(fixture.root);

    expect(captureRepositoryState(fixture.root)).not.toEqual(before);
  });
});

function commitAwkwardFile(root: string): string {
  commitFiles(root, { message: "awkward", changes: [{ kind: "write", path: "awkward.bin", content: AWKWARD_BYTES }] });
  return runFixtureGit(root, ["rev-parse", "HEAD:awkward.bin"]).trim();
}
