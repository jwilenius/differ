import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let directory: string;
let repo: string;
let remote: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "differ-release-"));
  repo = join(directory, "repo");
  remote = join(directory, "remote.git");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(resolve("scripts/release.sh"), join(repo, "scripts/release.sh"));
  const scripts = { typecheck: "node -e ''", test: "node -e ''", package: "node -e ''" };
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0", scripts }));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({
    name: "fixture", version: "0.1.0", lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "0.1.0" } },
  }));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.com");
  git("init", "-q", "--bare", remote);
  git("remote", "add", "origin", remote);
  git("add", ".");
  git("commit", "-qm", "Initial fixture");
  git("push", "-q", "-u", "origin", "main");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("release script", () => {
  it("updates both package files and publishes the matching commit and annotated tag", () => {
    const result = spawnSync("bash", ["scripts/release.sh", "0.1.1"], { cwd: repo, encoding: "utf8" });

    expect(result.stderr, result.stdout).not.toContain("fatal:");
    expect(result.status, result.stderr).toBe(0);
    for (const file of ["package.json", "package-lock.json"]) {
      expect(JSON.parse(readFileSync(join(repo, file), "utf8")).version).toBe("0.1.1");
    }
    expect(git("status", "--porcelain")).toBe("");
    expect(git("cat-file", "-t", "v0.1.1")).toBe("tag");
    expect(git("--git-dir", remote, "rev-parse", "refs/heads/main")).toBe(git("rev-parse", "HEAD"));
    expect(git("--git-dir", remote, "rev-parse", "v0.1.1^{}")).toBe(git("rev-parse", "HEAD"));
  }, 30_000);

  it.each(["0.1.0", "0.0.9", "01.2.3", "patch"])("rejects version %s without changing files", (version) => {
    const result = spawnSync("bash", ["scripts/release.sh", version], { cwd: repo, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("tag", "--list")).toBe("");
  });

  it("refuses uncommitted changes", () => {
    writeFileSync(join(repo, "uncommitted.txt"), "keep me");
    const result = spawnSync("bash", ["scripts/release.sh", "0.1.1"], { cwd: repo, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("clean working tree");
    expect(git("tag", "--list")).toBe("");
  });
});
