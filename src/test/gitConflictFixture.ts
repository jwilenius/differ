import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A temporary repository on `trunk`; remove it with `fs.rmSync(root, { recursive: true, force: true })`. */
export function createConflictRepository(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "differ-conflicts-")));
  execFileSync("git", ["init", "-q", "-b", "trunk", root], { stdio: "pipe" });
  runGit(root, "config", "user.email", "test@example.com");
  runGit(root, "config", "user.name", "Test");
  runGit(root, "config", "commit.gpgSign", "false");
  return root;
}

export function runGit(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

/** Commits different contents of `files` on `trunk` and a new branch `feature`, plus a file only `trunk` changes. */
export function divergeBranches(root: string, files: readonly string[]): void {
  const writeAll = (names: readonly string[], text: string): void => {
    for (const name of names) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
  };
  writeAll([...files, "clean.txt"], "base\n");
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "base");
  runGit(root, "checkout", "-q", "-b", "feature");
  writeAll(files, "feature\n");
  runGit(root, "commit", "-qam", "feature");
  runGit(root, "checkout", "-q", "trunk");
  writeAll([...files, "clean.txt"], "trunk\n");
  runGit(root, "commit", "-qam", "trunk");
}

/** Merges `feature` into `trunk`, leaving the diverged files conflicted. */
export function mergeFeature(root: string): void {
  try {
    runGit(root, "merge", "feature");
  } catch {
    // The merge is expected to conflict.
  }
}

/** The contents `divergeFile` commits: the common ancestor, then each branch's own version. */
export interface FileVersions {
  readonly base: string | Buffer;
  readonly feature: string | Buffer;
  readonly trunk: string | Buffer;
}

/** Commits `versions` of `name` as `divergeBranches` does, written byte for byte so any encoding can be tested. */
export function divergeFile(root: string, name: string, versions: FileVersions): void {
  const file = path.join(root, name);
  fs.writeFileSync(file, versions.base);
  runGit(root, "add", name);
  runGit(root, "commit", "-qm", "base");
  runGit(root, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(file, versions.feature);
  runGit(root, "commit", "-qam", "feature");
  runGit(root, "checkout", "-q", "trunk");
  fs.writeFileSync(file, versions.trunk);
  runGit(root, "commit", "-qam", "trunk");
}
