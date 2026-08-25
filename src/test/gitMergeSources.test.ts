import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMergeSources } from "../git/gitMergeSources";

let repo: string;
let file: string;

const git = (...args: string[]): void => {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
};

/** Builds a real repository whose merge leaves f.txt conflicted. */
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "differ-git-"));
  file = path.join(repo, "f.txt");

  execFileSync("git", ["init", "-q", "-b", "trunk", repo], { stdio: "pipe" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  fs.writeFileSync(file, "line1\nshared\nline3\n");
  git("add", "f.txt");
  git("commit", "-qm", "base");

  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(file, "line1\nMINE\nline3\nextra-mine\n");
  git("commit", "-qam", "mine");

  git("checkout", "-q", "trunk");
  fs.writeFileSync(file, "line1\nTHEIRS\nline3\n");
  git("commit", "-qam", "theirs");

  git("checkout", "-q", "feature");
  try {
    git("merge", "trunk");
  } catch {
    // The merge is expected to conflict.
  }
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("readMergeSources", () => {
  it("reads the branch version from the ours stage", async () => {
    const sources = await readMergeSources(file, fs.readFileSync(file, "utf8"));

    expect(sources?.ours).toBe("line1\nMINE\nline3\nextra-mine\n");
  });

  it("reads the incoming version from the theirs stage", async () => {
    const sources = await readMergeSources(file, fs.readFileSync(file, "utf8"));

    expect(sources?.theirs).toBe("line1\nTHEIRS\nline3\n");
  });

  it("reads the common ancestor from the base stage", async () => {
    const sources = await readMergeSources(file, fs.readFileSync(file, "utf8"));

    expect(sources?.base).toBe("line1\nshared\nline3\n");
  });

  it("takes the result from the working copy, markers and all", async () => {
    const working = fs.readFileSync(file, "utf8");
    const sources = await readMergeSources(file, working);

    expect(sources?.result).toBe(working);
    expect(sources?.result).toContain("<<<<<<<");
  });

  it("labels the panes with the two branch names", async () => {
    const sources = await readMergeSources(file, fs.readFileSync(file, "utf8"));

    expect(sources?.ourLabel).toBe("feature");
    expect(sources?.theirLabel).toBe("trunk");
  });

  it("reports a merge as not having the sides swapped", async () => {
    const sources = await readMergeSources(file, fs.readFileSync(file, "utf8"));

    expect(sources?.isSidesSwapped).toBe(false);
  });

  it("returns null for a file with no conflict stages", async () => {
    const clean = path.join(repo, "clean.txt");
    fs.writeFileSync(clean, "nothing to merge\n");

    expect(await readMergeSources(clean, "nothing to merge\n")).toBeNull();
  });

  it("returns null outside a git repository", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "differ-nogit-"));
    const orphan = path.join(outside, "f.txt");
    fs.writeFileSync(orphan, "text");

    expect(await readMergeSources(orphan, "text")).toBeNull();
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
