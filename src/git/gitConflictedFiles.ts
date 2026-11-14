import * as path from "node:path";
import { runHistoryGit } from "./historyGitCommand";

/** Index stage numbers git assigns during a conflicted merge. */
export const STAGE_BASE = 1;
export const STAGE_OURS = 2;
export const STAGE_THEIRS = 3;

/** Index modes of regular and executable files; others are symbolic links (120000) or submodules (160000). */
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

/** One index entry of a conflicted path, as `git ls-files -u` reports it. */
export interface UnmergedEntry {
  readonly mode: string;
  readonly oid: string;
  readonly stage: number;
  /** Relative to the directory Git ran in, `/`-separated. */
  readonly path: string;
}

/**
 * Absolute paths of the conflicted files in the repository at `root` that the merge view can open, in Git's order.
 * Conflicts it cannot merge, such as a deleted side or a symbolic link, are left out.
 */
export async function listConflictedFiles(root: string): Promise<readonly string[]> {
  const entries = await listUnmergedEntries(root);
  // A Map keeps paths in first-seen order, which is Git's order.
  const entriesByPath = new Map<string, readonly UnmergedEntry[]>();
  for (const entry of entries) {
    entriesByPath.set(entry.path, [...(entriesByPath.get(entry.path) ?? []), entry]);
  }
  return [...entriesByPath]
    .filter(([, pathEntries]) => isMergeableConflict(pathEntries))
    .map(([name]) => path.join(root, name));
}

/**
 * Stages `filePath`, marking its conflict resolved. The path is taken literally, so `[id].tsx` never also stages
 * `i.tsx`. Throws `HistoryGitError` when Git fails.
 */
export async function markResolved(filePath: string): Promise<void> {
  await runHistoryGit({ cwd: path.dirname(filePath), args: ["--literal-pathspecs", "add", "--", filePath] });
}

/**
 * Unmerged index entries of the repository at `cwd`, in Git's order, limited to `paths` when given. The paths are
 * taken literally. Throws `HistoryGitError` when Git fails.
 */
export async function listUnmergedEntries(cwd: string, paths: readonly string[] = []): Promise<readonly UnmergedEntry[]> {
  const result = await runHistoryGit({ cwd, args: ["--literal-pathspecs", "ls-files", "-u", "-z", "--", ...paths] });
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((record) => record !== "")
    .map(parseUnmergedEntry);
}

/** Parses one `<mode> <oid> <stage>\t<path>` record. */
function parseUnmergedEntry(record: string): UnmergedEntry {
  const tab = record.indexOf("\t");
  const [mode, oid, stage] = record.slice(0, tab).split(" ");
  return { mode, oid, stage: Number(stage), path: record.slice(tab + 1) };
}

/**
 * True when the entries of one path are a conflict the merge view can merge as text: both sides are present and every
 * stage is a regular file. Merging a symbolic link would write the result through it to wherever it points.
 */
export function isMergeableConflict(entries: readonly UnmergedEntry[]): boolean {
  const hasBothSides = [STAGE_OURS, STAGE_THEIRS].every((stage) => entries.some((entry) => entry.stage === stage));
  const areAllRegularFiles = entries.every((entry) => REGULAR_FILE_MODES.has(entry.mode));
  return hasBothSides && areAllRegularFiles;
}
