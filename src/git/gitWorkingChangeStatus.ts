import { WORKING_CHANGE_PATH_LIMIT } from "../model/historyWorkingChanges";
import type { WorkingChangeSummary } from "../model/historyWorkingChanges";
import { HistoryOutputError } from "./gitHistoryRepository";
import { HistoryGitError, runHistoryGit } from "./historyGitCommand";
import type { HistoryGitResult } from "./historyGitCommand";

/**
 * Global options for every working-tree read: no optional index refresh (so the index is never locked or rewritten)
 * and no file-system monitor daemon started on the user's behalf, including through the older built-in setting.
 */
export const WORKING_TREE_READ_OPTIONS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.useBuiltinFSMonitor=false",
] as const;

const SPACE_BYTE = 0x20;
const NO_CHANGE = ".";
const SUBMODULE_MARKER = "S";
const RENAMED = "R";
const UNTRACKED_DIRECTORY_SUFFIX = "/";
/** Spaces before the path in porcelain v2 records: ordinary `1`, renamed or copied `2`, and unmerged `u`. */
const PATH_FIELD_OFFSETS: Readonly<Record<string, number>> = { "1": 8, "2": 9, "u": 10 };
const UNTRACKED_PATH_OFFSET = 2;
const INDEX_STATUS_OFFSET = 2;
const WORKTREE_STATUS_OFFSET = 3;
const SUBMODULE_OFFSET = 5;
const UNTRACKED_OFF_VALUES: ReadonlySet<string> = new Set(["no", "false", "off", "0"]);
const CONFIG_UNSET_EXIT_CODE = 1;

/** Runs Git in the working tree being read, with the signal and environment already bound. */
export type WorkingTreeGit = (args: readonly string[], allowedExitCodes?: readonly number[]) => Promise<HistoryGitResult>;

/** What `git status` reports about the working tree, with the paths needed to rebuild its trees. */
export interface WorkingChangeStatus {
  readonly summary: WorkingChangeSummary;
  /** Raw path bytes whose working-tree file differs from the index: changed, deleted, untracked or conflicted. */
  readonly worktreePaths: readonly Buffer[];
  /** Raw path bytes with unresolved merge conflicts. */
  readonly conflictedPaths: readonly Buffer[];
}

/** Counts accumulated while reading status records. */
interface StatusTally {
  staged: number;
  unstaged: number;
  untracked: number;
  readonly worktreePaths: Buffer[];
  readonly conflictedPaths: Buffer[];
}

/**
 * Counts staged, unstaged, untracked and conflicted files of the repository at `root` without writing anything: the
 * index is read but never refreshed or locked. Null for a repository without a working tree, or whose status cannot
 * be read.
 */
export async function readWorkingChangeSummary(
  root: string,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<WorkingChangeSummary | null> {
  const git: WorkingTreeGit = (args, allowedExitCodes) => runHistoryGit({
    cwd: root,
    args: [...WORKING_TREE_READ_OPTIONS, ...args],
    signal,
    ...(env === undefined ? {} : { env }),
    ...(allowedExitCodes === undefined ? {} : { allowedExitCodes }),
  });

  try {
    return (await readWorkingChangeStatus(git)).summary;
  } catch (error) {
    if (error instanceof HistoryGitError && error.kind === "failed") {
      return null;
    }
    throw error;
  }
}

/**
 * Reads `git status` through `git`, listing untracked files one by one unless `status.showUntrackedFiles` turns
 * them off. Renames count once; submodule content changes are left out because their gitlinks stay as recorded.
 */
export async function readWorkingChangeStatus(git: WorkingTreeGit): Promise<WorkingChangeStatus> {
  const untrackedMode = await readUntrackedMode(git);
  const result = await git(["status", "--porcelain=v2", "-z", `--untracked-files=${untrackedMode}`]);
  return parseStatus(result.stdout);
}

async function readUntrackedMode(git: WorkingTreeGit): Promise<"no" | "all"> {
  const args = ["config", "--get", "status.showUntrackedFiles"];
  const result = await git(args, [0, CONFIG_UNSET_EXIT_CODE]);
  const value = result.stdout.toString("utf8").trim().toLowerCase();
  return UNTRACKED_OFF_VALUES.has(value) ? "no" : "all";
}

/** Parses `--porcelain=v2 -z` output, stopping after `WORKING_CHANGE_PATH_LIMIT` changed paths. */
export function parseStatus(output: Buffer): WorkingChangeStatus {
  const records = nulRecords(output);
  const tally: StatusTally = { staged: 0, unstaged: 0, untracked: 0, worktreePaths: [], conflictedPaths: [] };
  let pathCount = 0;
  let isTruncated = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const kind = String.fromCharCode(record[0] ?? 0);
    // A rename or copy record is followed by its original path.
    const originalPath = kind === "2" ? records[++index] : undefined;
    if (!isChangeRecord(kind)) {
      continue;
    }
    if (pathCount === WORKING_CHANGE_PATH_LIMIT) {
      isTruncated = true;
      break;
    }
    pathCount += 1;
    countRecord(tally, kind, record, originalPath);
  }

  const { staged, unstaged, untracked, worktreePaths, conflictedPaths } = tally;
  const conflicted = conflictedPaths.length;
  return { summary: { staged, unstaged, untracked, conflicted, isTruncated }, worktreePaths, conflictedPaths };
}

function isChangeRecord(kind: string): boolean {
  return kind === "?" || kind in PATH_FIELD_OFFSETS;
}

function countRecord(tally: StatusTally, kind: string, record: Buffer, originalPath: Buffer | undefined): void {
  if (kind === "?") {
    countUntracked(tally, record.subarray(UNTRACKED_PATH_OFFSET));
    return;
  }

  const recordPath = pathAfterSpaces(record, PATH_FIELD_OFFSETS[kind]!);
  if (kind === "u") {
    tally.unstaged += 1;
    tally.worktreePaths.push(recordPath);
    tally.conflictedPaths.push(recordPath);
    return;
  }

  // `<kind> <X><Y> <submodule> …`: X is the index status, Y the working-tree status.
  if (record.toString("latin1", INDEX_STATUS_OFFSET, INDEX_STATUS_OFFSET + 1) !== NO_CHANGE) {
    tally.staged += 1;
  }
  const worktreeStatus = record.toString("latin1", WORKTREE_STATUS_OFFSET, WORKTREE_STATUS_OFFSET + 1);
  const isSubmodule = record.toString("latin1", SUBMODULE_OFFSET, SUBMODULE_OFFSET + 1) === SUBMODULE_MARKER;
  const hasWorktreeChange = worktreeStatus !== NO_CHANGE && !isSubmodule;
  if (hasWorktreeChange) {
    tally.unstaged += 1;
    // Only a rename in the working tree changes the old path there; after one in the index alone it is untracked.
    const isWorktreeRename = worktreeStatus === RENAMED && originalPath !== undefined;
    tally.worktreePaths.push(recordPath, ...(isWorktreeRename ? [originalPath] : []));
  }
}

/** A nested repository shows as an untracked directory; it has no file content to compare. */
function countUntracked(tally: StatusTally, untrackedPath: Buffer): void {
  const isNestedRepository = untrackedPath.toString("latin1").endsWith(UNTRACKED_DIRECTORY_SUFFIX);
  if (isNestedRepository) {
    return;
  }
  tally.unstaged += 1;
  tally.untracked += 1;
  tally.worktreePaths.push(untrackedPath);
}

function pathAfterSpaces(record: Buffer, spaceCount: number): Buffer {
  let position = -1;
  for (let count = 0; count < spaceCount; count += 1) {
    position = record.indexOf(SPACE_BYTE, position + 1);
    if (position === -1) {
      throw new HistoryOutputError("Git status printed a record without a path.");
    }
  }
  return record.subarray(position + 1);
}

function nulRecords(output: Buffer): readonly Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
    records.push(output.subarray(start, end));
    start = end + 1;
  }
  return records;
}

