import * as path from "node:path";
import { type NonTextBlobReason, nonTextBlobReason } from "./gitBlobText";
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
 * Why a file's conflict cannot be merged as text: it has no conflict stages, lacks a side or has a stage that is not
 * a regular file, such as a symbolic link or submodule; or a stage is binary or not UTF-8, so merging it as text
 * would corrupt it.
 */
export type UnmergeableReason = "noMergeableConflict" | NonTextBlobReason;

export interface UnmergeableConflict {
  readonly unmergeable: UnmergeableReason;
}

const NO_MERGEABLE_CONFLICT: UnmergeableConflict = { unmergeable: "noMergeableConflict" };
const BYTE_ORDER_MARK = "\uFEFF";

/** Reads the three versions of a conflicted file from the git index, or why they cannot be merged. */
export async function readMergeSources(filePath: string, result: string): Promise<MergeSources | UnmergeableConflict> {
  const root = await repositoryRoot(filePath);
  if (!root) {
    return NO_MERGEABLE_CONFLICT;
  }

  const relativePath = toPosix(path.relative(root, filePath));
  const entries = await conflictEntries(root, relativePath);
  if (!isMergeableConflict(entries)) {
    return NO_MERGEABLE_CONFLICT;
  }

  const stages = await stagedVersions(root, entries);
  if (stages.ours === null || stages.theirs === null) {
    return NO_MERGEABLE_CONFLICT;
  }
  const nonTextReason = nonTextStageReason(stages);
  if (nonTextReason !== null) {
    return { unmergeable: nonTextReason };
  }

  const isSidesSwapped = await isReplayInProgress(root);

  return {
    ours: stageText(stages.ours),
    theirs: stageText(stages.theirs),
    base: stages.base === null ? null : stageText(stages.base),
    result,
    ourLabel: await describeHead(root),
    theirLabel: await describeIncoming(root),
    isSidesSwapped,
  };
}

interface StagedVersions {
  readonly base: Buffer | null;
  readonly ours: Buffer | null;
  readonly theirs: Buffer | null;
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
async function readStage(root: string, entries: readonly UnmergedEntry[], stage: number): Promise<Buffer | null> {
  const entry = entries.find((candidate) => candidate.stage === stage);
  return entry === undefined ? null : gitOutput(root, ["cat-file", "blob", entry.oid]);
}

/** Why some present stage is not text; null when all are. */
function nonTextStageReason(stages: StagedVersions): NonTextBlobReason | null {
  for (const blob of [stages.base, stages.ours, stages.theirs]) {
    const reason = blob === null ? null : nonTextBlobReason(blob);
    if (reason !== null) {
      return reason;
    }
  }
  return null;
}

/**
 * A stage's text without a leading byte order mark. The mark belongs to the file's encoding, not its text: an editor
 * such as VS Code leaves it out of the document and writes it back on save, so a merged mark would be saved twice.
 */
function stageText(blob: Buffer): string {
  const text = blob.toString("utf8");
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
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

/** Runs git for text output, returning `null` for any Git failure so callers can fall back. */
async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  const output = await gitOutput(cwd, args);
  return output === null ? null : output.toString("utf8");
}

/** Runs git, returning its raw output, or `null` for any Git failure. */
async function gitOutput(cwd: string, args: readonly string[]): Promise<Buffer | null> {
  try {
    const { stdout } = await runHistoryGit({ cwd, args });
    return stdout;
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
