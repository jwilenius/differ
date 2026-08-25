import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Index stage numbers git assigns during a conflicted merge. */
const STAGE_BASE = 1;
const STAGE_OURS = 2;
const STAGE_THEIRS = 3;

export interface MergeSources {
  /** The branch's own version of the file — git stage 2. */
  readonly ours: string;
  /** The version being merged in, which conflicts with ours — git stage 3. */
  readonly theirs: string;
  /** Common ancestor — git stage 1. Absent for add/add conflicts. */
  readonly base: string | null;
  /** The working copy: what will actually be committed. */
  readonly result: string;
  readonly ourLabel: string;
  readonly theirLabel: string;
  /**
   * True during a rebase or cherry-pick, where git's "ours" is the branch being
   * replayed onto and "theirs" is your own commit — the reverse of a merge.
   */
  readonly isSidesSwapped: boolean;
}

/**
 * Reads the three versions of a conflicted file from the git index. Returns
 * `null` when the file has no conflict stages, in which case the caller should
 * fall back to parsing conflict markers out of the working copy.
 */
export async function readMergeSources(filePath: string, result: string): Promise<MergeSources | null> {
  const root = await repositoryRoot(filePath);
  if (!root) {
    return null;
  }

  const relativePath = toPosix(path.relative(root, filePath));
  const stages = await stagedVersions(root, relativePath);
  if (!stages.ours || !stages.theirs) {
    return null;
  }

  const isSidesSwapped = await isReplayInProgress(root);

  return {
    ours: stages.ours,
    theirs: stages.theirs,
    base: stages.base,
    result,
    ourLabel: await describeHead(root),
    theirLabel: await describeIncoming(root),
    isSidesSwapped,
  };
}

interface StagedVersions {
  readonly base: string | null;
  readonly ours: string | null;
  readonly theirs: string | null;
}

async function stagedVersions(root: string, relativePath: string): Promise<StagedVersions> {
  const [base, ours, theirs] = await Promise.all([
    showStage(root, STAGE_BASE, relativePath),
    showStage(root, STAGE_OURS, relativePath),
    showStage(root, STAGE_THEIRS, relativePath),
  ]);

  return { base, ours, theirs };
}

async function showStage(root: string, stage: number, relativePath: string): Promise<string | null> {
  return git(root, ["show", `:${stage}:${relativePath}`]);
}

async function repositoryRoot(filePath: string): Promise<string | null> {
  const directory = path.dirname(filePath);
  const root = await git(directory, ["rev-parse", "--show-toplevel"]);
  return root === null ? null : root.trim();
}

/** Rebase and cherry-pick replay commits, which swaps the meaning of the two sides. */
async function isReplayInProgress(root: string): Promise<boolean> {
  const mergeHead = await git(root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  return mergeHead === null;
}

async function describeHead(root: string): Promise<string> {
  const branch = await git(root, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  return branch?.trim() || "Your branch";
}

async function describeIncoming(root: string): Promise<string> {
  for (const ref of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    const name = await git(root, ["name-rev", "--name-only", "--exclude=tags/*", ref]);
    if (name !== null && name.trim() !== "" && !name.startsWith("undefined")) {
      return name.trim();
    }
  }
  return "Incoming";
}

/** Runs git, returning `null` for any failure so callers can fall back. */
async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
