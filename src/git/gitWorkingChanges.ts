import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NonTextReason } from "../model/historyTypes";
import { nonTextBlobReason } from "./gitBlobText";
import { COMPARISON_FILE_LIMIT_BYTES } from "./gitComparisonFiles";
import { runHistoryGit } from "./historyGitCommand";

export const HEAD_LABEL = "HEAD";
export const INDEX_LABEL = "Index";
export const WORKING_TREE_LABEL = "Working Tree";

/** One version of a changed file, as the comparison shows it. */
export interface ChangeSide {
  readonly label: string;
  /** Repository-relative path; empty when this version has no file. */
  readonly path: string;
  /** The version's text with LF line endings. */
  readonly text: string;
}

/** The two versions of an uncommitted change. */
export interface ChangeComparison {
  readonly base: ChangeSide;
  readonly result: ChangeSide;
  /** False when the change deletes the file, so the result side is empty. */
  readonly hasResultFile: boolean;
}

/**
 * Why a change cannot be compared as text: a version is binary, not UTF-8 or too large, or is not a file, such as a
 * submodule or a directory.
 */
export type UnreadableChangeReason = NonTextReason | "notAFile";

export interface UnreadableChange {
  readonly unreadable: UnreadableChangeReason;
}

export type ChangeReadResult = ChangeComparison | UnreadableChange;

/** A version's text, why it cannot be shown as text, or `null` when that version has no file. */
type VersionContent = { readonly text: string } | UnreadableChange | null;

/** Where Git runs for a file and how it names that file. */
interface FileLocation {
  /** The nearest existing directory holding the file; Git runs here. */
  readonly directory: string;
  /** The file's path relative to `directory`, with forward slashes. */
  readonly pathspec: string;
  /** The file's path relative to the repository root, as Git prints it. */
  readonly repositoryPath: string;
}

/** A file's entry in the index or a tree: its mode and object id, and its repository-relative path. */
interface GitEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
}

interface IndexEntry extends GitEntry {
  readonly stage: number;
}

const GITLINK_MODE = "160000";
const STAGE_MERGED = 0;
/** Git's exit code when a `--quiet` lookup finds nothing, as an unborn HEAD. */
const NOT_FOUND_EXIT_CODE = 1;
const RENAME_STATUS = "R";
const RECORD_FIELDS = 2;
const RENAME_RECORD_FIELDS = 3;
const NO_FILE_PATH = "";
const NO_FILE_TEXT = "";

/**
 * The unstaged change of the file at `filePath`: its index version, or none when the file is untracked, against its
 * working-tree version. While only conflict stages are in the index the base is HEAD's version. `unsavedText` is the
 * editor's text of a file with unsaved edits, which replaces the file on disk. Throws `HistoryGitError` when Git fails.
 */
export async function readWorkingTreeChange(filePath: string, unsavedText?: string): Promise<ChangeReadResult> {
  const location = await locateFile(filePath);
  const indexEntries = await readIndexEntries(location);
  const mergedEntry = indexEntries.find((entry) => entry.stage === STAGE_MERGED);
  const isConflicted = mergedEntry === undefined && indexEntries.length > 0;
  const baseEntry = isConflicted ? await readHeadEntry(location, location.repositoryPath) : mergedEntry;
  const baseLabel = isConflicted ? HEAD_LABEL : INDEX_LABEL;

  const base = await readBlobVersion(location.directory, baseEntry ?? null);
  const result = unsavedText === undefined ? await readWorkingFile(filePath) : { text: unsavedText };
  return compareVersions({
    base: { label: baseLabel, path: location.repositoryPath, content: base },
    result: { label: WORKING_TREE_LABEL, path: location.repositoryPath, content: result },
  });
}

/**
 * The staged change of the file at `filePath`: its HEAD version, at its old path when the index renames it, against its
 * index version. Throws `HistoryGitError` when Git fails.
 */
export async function readStagedChange(filePath: string): Promise<ChangeReadResult> {
  const location = await locateFile(filePath);
  const indexEntries = await readIndexEntries(location);
  const indexEntry = indexEntries.find((entry) => entry.stage === STAGE_MERGED) ?? null;
  const headPath = (await hasHead(location.directory)) ? await findHeadPath(location) : null;
  const headEntry = headPath === null ? undefined : await readTreeEntry(location, headPath);

  const base = await readBlobVersion(location.directory, headEntry ?? null);
  const result = await readBlobVersion(location.directory, indexEntry);
  return compareVersions({
    base: { label: HEAD_LABEL, path: headPath ?? NO_FILE_PATH, content: base },
    result: { label: INDEX_LABEL, path: location.repositoryPath, content: result },
  });
}

/** Locates the file from its nearest existing directory, so a file whose directory was deleted is still found. */
async function locateFile(filePath: string): Promise<FileLocation> {
  const directory = await nearestExistingDirectory(path.dirname(filePath));
  const pathspec = path.relative(directory, filePath).split(path.sep).join("/");
  const { stdout } = await runHistoryGit({ cwd: directory, args: ["rev-parse", "--show-prefix"] });
  const prefix = stdout.toString("utf8").replace(/\n$/, "");
  return { directory, pathspec, repositoryPath: prefix + pathspec };
}

async function nearestExistingDirectory(directory: string): Promise<string> {
  const isDirectory = await fs.stat(directory).then((stats) => stats.isDirectory(), () => false);
  const parent = path.dirname(directory);
  if (isDirectory || parent === directory) {
    return directory;
  }
  return nearestExistingDirectory(parent);
}

/** The file's index entries: one at stage 0, or its conflict stages; none when it is untracked. */
async function readIndexEntries(location: FileLocation): Promise<readonly IndexEntry[]> {
  const args = ["--literal-pathspecs", "ls-files", "--stage", "-z", "--full-name", "--", location.pathspec];
  const { stdout } = await runHistoryGit({ cwd: location.directory, args });
  return splitRecords(stdout)
    .map(parseIndexRecord)
    // A directory's pathspec also matches the files under it.
    .filter((entry) => entry.path === location.repositoryPath);
}

/** `<mode> <oid> <stage>\t<path>`, as `ls-files --stage` prints an entry. */
function parseIndexRecord(record: string): IndexEntry {
  const tab = record.indexOf("\t");
  const [mode = "", oid = "", stage = ""] = record.slice(0, tab).split(" ");
  return { mode, oid, stage: Number(stage), path: record.slice(tab + 1) };
}

/** HEAD's entry at the repository path `repositoryPath`; none when HEAD lacks it or is unborn. */
async function readHeadEntry(location: FileLocation, repositoryPath: string): Promise<GitEntry | undefined> {
  return (await hasHead(location.directory)) ? readTreeEntry(location, repositoryPath) : undefined;
}

/** The entry of an existing HEAD at the repository path `repositoryPath`; none when HEAD lacks it. */
async function readTreeEntry({ directory }: FileLocation, repositoryPath: string): Promise<GitEntry | undefined> {
  const args = ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", "HEAD", "--", repositoryPath];
  const { stdout } = await runHistoryGit({ cwd: directory, args });
  return splitRecords(stdout).map(parseTreeRecord).find((entry) => entry.path === repositoryPath);
}

/** `<mode> <type> <oid>\t<path>`, as `ls-tree` prints an entry. */
function parseTreeRecord(record: string): GitEntry {
  const tab = record.indexOf("\t");
  const [mode = "", , oid = ""] = record.slice(0, tab).split(" ");
  return { mode, oid, path: record.slice(tab + 1) };
}

async function hasHead(directory: string): Promise<boolean> {
  const args = ["rev-parse", "--verify", "--quiet", "HEAD"];
  const { exitCode } = await runHistoryGit({ cwd: directory, args, allowedExitCodes: [0, NOT_FOUND_EXIT_CODE] });
  return exitCode === 0;
}

/**
 * The repository path an existing HEAD holds the staged file's version at: its old path when the index renames it,
 * otherwise its own path. Renames are found between HEAD and the whole index, as the Source Control view finds them.
 */
async function findHeadPath(location: FileLocation): Promise<string> {
  const args = ["diff-index", "--cached", "-z", "--name-status", "--find-renames", "HEAD", "--"];
  const { stdout } = await runHistoryGit({ cwd: location.directory, args });
  const fields = splitRecords(stdout);
  let index = 0;
  while (index < fields.length) {
    const isRename = fields[index]?.startsWith(RENAME_STATUS) === true;
    if (isRename && fields[index + 2] === location.repositoryPath) {
      return fields[index + 1] ?? location.repositoryPath;
    }
    // A rename record holds its status, old path and new path; any other its status and path.
    index += isRename ? RENAME_RECORD_FIELDS : RECORD_FIELDS;
  }
  return location.repositoryPath;
}

/** NUL-terminated records, as Git prints them with `-z`. */
function splitRecords(output: Buffer): readonly string[] {
  return output.toString("utf8").split("\0").filter((record) => record !== "");
}

/** The content of a blob entry; a symbolic link's is its target. */
async function readBlobVersion(directory: string, entry: GitEntry | null): Promise<VersionContent> {
  if (entry === null) {
    return null;
  }
  if (entry.mode === GITLINK_MODE) {
    return { unreadable: "notAFile" };
  }
  const size = await runHistoryGit({ cwd: directory, args: ["cat-file", "-s", entry.oid] });
  if (Number(size.stdout.toString("utf8").trim()) > COMPARISON_FILE_LIMIT_BYTES) {
    return { unreadable: "oversize" };
  }
  const { stdout } = await runHistoryGit({ cwd: directory, args: ["cat-file", "blob", entry.oid] });
  return decodeVersion(stdout);
}

/** The working-tree file's content; a symbolic link's is its target, as Git stores it. */
async function readWorkingFile(filePath: string): Promise<VersionContent> {
  const stats = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return null;
    }
    throw error;
  });
  if (stats === null) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    return { text: await fs.readlink(filePath) };
  }
  if (!stats.isFile()) {
    return { unreadable: "notAFile" };
  }
  if (stats.size > COMPARISON_FILE_LIMIT_BYTES) {
    return { unreadable: "oversize" };
  }
  return decodeVersion(await fs.readFile(filePath));
}

function decodeVersion(content: Buffer): VersionContent {
  const reason = nonTextBlobReason(content);
  return reason === null ? { text: content.toString("utf8") } : { unreadable: reason };
}

interface VersionToCompare {
  readonly label: string;
  readonly path: string;
  readonly content: VersionContent;
}

/** Builds the comparison; an absent version is empty and unnamed, and an unreadable one makes the change unreadable. */
function compareVersions(versions: { base: VersionToCompare; result: VersionToCompare }): ChangeReadResult {
  const { base, result } = versions;
  if (isUnreadable(base.content)) {
    return base.content;
  }
  if (isUnreadable(result.content)) {
    return result.content;
  }
  return {
    base: toSide(base.label, base.path, base.content),
    result: toSide(result.label, result.path, result.content),
    hasResultFile: result.content !== null,
  };
}

function isUnreadable(content: VersionContent): content is UnreadableChange {
  return content !== null && "unreadable" in content;
}

/**
 * A version's side with LF line endings: the index holds Git's LF form of a file the working tree may hold with CRLF,
 * as with `core.autocrlf`, and VS Code's diff does not show line-ending differences either.
 */
function toSide(label: string, filePath: string, content: { readonly text: string } | null): ChangeSide {
  if (content === null) {
    return { label, path: NO_FILE_PATH, text: NO_FILE_TEXT };
  }
  return { label, path: filePath, text: normalizeEol(content.text) };
}

/** A lone CR breaks the line too, as in VS Code's editor and jw-differ's merge view. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
