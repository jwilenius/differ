import * as fs from "node:fs";
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
  readonly ourLabel: string;
  readonly theirLabel: string;
  /**
   * True during a rebase, where git's "ours" is the branch being replayed onto
   * and "theirs" is your own commit — the reverse of a merge.
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
/** Git's exit code for a fatal error, which is how it reports a directory outside any repository. */
const FATAL_EXIT_CODE = 128;
/** Git's exit code when a `--quiet` lookup finds nothing, as a missing ref or a detached HEAD. */
const NOT_FOUND_EXIT_CODE = 1;
/**
 * State a rebase keeps in the git directory: `rebase-merge` for the default backend, `rebase-apply/rebasing` for
 * `--apply`, whose `rebase-apply` directory `git am` shares without the `rebasing` marker.
 */
const REBASE_STATE_PATHS: readonly string[] = ["rebase-merge", "rebase-apply/rebasing"];

/**
 * Reads the three versions of a conflicted file from the git index, or why they cannot be merged. Git runs in the
 * file's own directory and is given only its name: Git resolves symbolic links in the repository root, so a path
 * relative to that root would leave the repository when the file was opened through a linked directory. Throws
 * `HistoryGitError` when Git is missing or fails other than by finding no repository.
 */
export async function readMergeSources(filePath: string): Promise<MergeSources | UnmergeableConflict> {
  const directory = path.dirname(filePath);
  const entries = await conflictEntries(directory, path.basename(filePath));
  if (!isMergeableConflict(entries)) {
    return NO_MERGEABLE_CONFLICT;
  }

  const stages = await stagedVersions(directory, entries);
  if (stages.ours === null || stages.theirs === null) {
    return NO_MERGEABLE_CONFLICT;
  }
  const nonTextReason = nonTextStageReason(stages);
  if (nonTextReason !== null) {
    return { unmergeable: nonTextReason };
  }

  const isSidesSwapped = await isRebaseInProgress(directory);

  return {
    ours: stageText(stages.ours),
    theirs: stageText(stages.theirs),
    base: stages.base === null ? null : stageText(stages.base),
    ourLabel: await describeHead(directory),
    theirLabel: await describeIncoming(directory),
    isSidesSwapped,
  };
}

interface StagedVersions {
  readonly base: Buffer | null;
  readonly ours: Buffer | null;
  readonly theirs: Buffer | null;
}

/**
 * The unmerged index entries of the file `fileName` in `directory`; none outside a repository. Git reports that only
 * by a fatal exit, which other fatal errors such as an unsafe repository share, so those read as no conflict too, as
 * they read as no repository when the history finds its repository root.
 */
async function conflictEntries(directory: string, fileName: string): Promise<readonly UnmergedEntry[]> {
  try {
    return await listUnmergedEntries(directory, [fileName]);
  } catch (error) {
    if (error instanceof HistoryGitError && error.exitCode === FATAL_EXIT_CODE) {
      return [];
    }
    throw error;
  }
}

async function stagedVersions(directory: string, entries: readonly UnmergedEntry[]): Promise<StagedVersions> {
  const [base, ours, theirs] = await Promise.all([
    readStage(directory, entries, STAGE_BASE),
    readStage(directory, entries, STAGE_OURS),
    readStage(directory, entries, STAGE_THEIRS),
  ]);

  return { base, ours, theirs };
}

/** Reads a stage by object id, so the content is the blob whose mode was checked; `null` when the stage is absent. */
async function readStage(directory: string, entries: readonly UnmergedEntry[], stage: number): Promise<Buffer | null> {
  const entry = entries.find((candidate) => candidate.stage === stage);
  if (entry === undefined) {
    return null;
  }
  const { stdout } = await runHistoryGit({ cwd: directory, args: ["cat-file", "blob", entry.oid] });
  return stdout;
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

/**
 * A rebase replays your commits onto the other branch, which swaps the meaning of the two sides. Every other
 * operation, such as a merge, cherry-pick, revert, popped stash or three-way patch, applies a change onto your
 * branch, which stays "ours". The state paths are resolved by Git, which places them correctly in a worktree.
 */
async function isRebaseInProgress(directory: string): Promise<boolean> {
  const mergeHead = await git(directory, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  if (mergeHead !== null) {
    return false;
  }
  const args = ["rev-parse", ...REBASE_STATE_PATHS.flatMap((statePath) => ["--git-path", statePath])];
  const { stdout } = await runHistoryGit({ cwd: directory, args });
  const statePaths = stdout.toString("utf8").split("\n").filter((line) => line !== "");
  return statePaths.some((statePath) => fs.existsSync(path.resolve(directory, statePath)));
}

async function describeHead(directory: string): Promise<string> {
  const branch = await git(directory, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  return branch?.trim() || "Your branch";
}

async function describeIncoming(directory: string): Promise<string> {
  for (const ref of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    const name = await git(directory, ["name-rev", "--name-only", "--exclude=tags/*", ref]);
    if (name !== null && name.trim() !== "" && !name.startsWith("undefined")) {
      return name.trim();
    }
  }
  return "Incoming";
}

/** Runs a git lookup for text output; `null` when it finds nothing. Throws `HistoryGitError` when Git fails. */
async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  const { stdout, exitCode } = await runHistoryGit({ cwd, args, allowedExitCodes: [0, NOT_FOUND_EXIT_CODE] });
  return exitCode === NOT_FOUND_EXIT_CODE ? null : stdout.toString("utf8");
}
