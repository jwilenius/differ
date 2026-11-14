import * as path from "node:path";
import {
  isMergeableConflict,
  listUnmergedEntries,
  STAGE_BASE,
  STAGE_OURS,
  STAGE_THEIRS,
  type UnmergedEntry,
} from "./gitConflictedFiles";
import { HistoryGitError, runHistoryGit } from "./historyGitCommand";

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
 * `null` when the file has no conflict stages, lacks a side, or has a stage
 * that is not a regular file, such as a symbolic link or submodule.
 */
export async function readMergeSources(filePath: string, result: string): Promise<MergeSources | null> {
  const root = await repositoryRoot(filePath);
  if (!root) {
    return null;
  }

  const relativePath = toPosix(path.relative(root, filePath));
  const entries = await conflictEntries(root, relativePath);
  if (!isMergeableConflict(entries)) {
    return null;
  }

  const stages = await stagedVersions(root, entries);
  if (stages.ours === null || stages.theirs === null) {
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

/** The file's unmerged index entries; none when Git fails. */
async function conflictEntries(root: string, relativePath: string): Promise<readonly UnmergedEntry[]> {
  try {
    return await listUnmergedEntries(root, [relativePath]);
  } catch (error) {
    if (error instanceof HistoryGitError) {
      return [];
    }
    throw error;
  }
}

async function stagedVersions(root: string, entries: readonly UnmergedEntry[]): Promise<StagedVersions> {
  const [base, ours, theirs] = await Promise.all([
    readStage(root, entries, STAGE_BASE),
    readStage(root, entries, STAGE_OURS),
    readStage(root, entries, STAGE_THEIRS),
  ]);

  return { base, ours, theirs };
}

/** Reads a stage by object id, so the content is the blob whose mode was checked; `null` when the stage is absent. */
async function readStage(root: string, entries: readonly UnmergedEntry[], stage: number): Promise<string | null> {
  const entry = entries.find((candidate) => candidate.stage === stage);
  return entry === undefined ? null : git(root, ["cat-file", "blob", entry.oid]);
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

/** Runs git, returning `null` for any Git failure so callers can fall back. */
async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await runHistoryGit({ cwd, args });
    return stdout.toString("utf8");
  } catch (error) {
    if (error instanceof HistoryGitError) {
      return null;
    }
    throw error;
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
