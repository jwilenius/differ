import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import type {
  ComparisonFile,
  ComparisonFileSide,
  FileContentKind,
  FileContentResult,
  FileSide,
  FileStatus,
  NonTextReason,
} from "../model/historyTypes";
import { HistoryOutputError, isFullOid } from "./gitHistoryRepository";
import { runPrivateGit } from "./gitSelectionReplay";
import type { ReplaySession } from "./gitSelectionReplay";

/** Largest blob decoded for display; larger sides are described instead of loaded. */
export const COMPARISON_FILE_LIMIT_BYTES = 16 * 1024 * 1024;

const GITLINK_MODE = "160000";
const ABSENT_MODE = "000000";
const MODE_PATTERN = /^[0-7]{6}$/;
const NUL_BYTE = 0;
/** Git's `--numstat` marker for content it considers binary. */
const BINARY_NUMSTAT_PREFIX = "-\t-\t";
/** `-z` fields per `--raw` record: header and path, or header, old path and new path for a rename. */
const RAW_FIELD_COUNT = 2;
const RENAME_RAW_FIELD_COUNT = 3;
/** `-z` fields per `--numstat` record: counts with path, or counts followed by old and new path for a rename. */
const NUMSTAT_FIELD_COUNT = 1;
const RENAME_NUMSTAT_FIELD_COUNT = 3;
const DIFF_OPTIONS = [
  "--no-commit-id",
  "-r",
  "--raw",
  "--numstat",
  "-z",
  "--no-abbrev",
  "--find-renames=50%",
  "--no-ext-diff",
  "--no-textconv",
] as const;

const STATUS_BY_LETTER: Readonly<Record<string, FileStatus>> = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "typeChanged",
};

const EMPTY_TEXT: FileContentResult = { kind: "text", text: "" };

/** One `--raw` record: metadata plus the old and new paths, which differ only for renames. */
interface RawChange {
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldOid: string;
  readonly newOid: string;
  readonly status: FileStatus;
  readonly oldPath: string;
  readonly newPath: string;
}

interface ParsedRawChange {
  readonly value: RawChange;
  /** Index of the field after this record. */
  readonly next: number;
}

interface DiffRecord {
  readonly change: RawChange;
  /** Git's own binary detection, which only samples the start of the content. */
  readonly isBinary: boolean;
}

/**
 * The net changes between the session's base and result trees, with renames detected. Changes that cancel out are
 * absent because the trees are compared, not the replayed patches. `contentKind` is Git's classification;
 * `readComparisonFile` still reports content that turns out not to be UTF-8 text as non-text.
 */
export async function readComparisonFiles(
  session: ReplaySession,
  signal: AbortSignal,
): Promise<readonly ComparisonFile[]> {
  const args = ["diff-tree", ...DIFF_OPTIONS, session.baseTreeOid, session.resultTreeOid, "--"];
  const result = await runPrivateGit(session.repository, args, signal);
  return parseDiffRecords(result.stdout).map(toComparisonFile);
}

/**
 * Exact content of one side of a file, read by its verified blob ID so paths never act as revision syntax. A missing
 * side is empty text; gitlinks show their commit ID; symlinks show their target bytes.
 */
export async function readComparisonFile(
  session: ReplaySession,
  file: ComparisonFile,
  side: FileSide,
  signal: AbortSignal,
): Promise<FileContentResult> {
  const fileSide = file[side];
  if (fileSide === null) {
    return EMPTY_TEXT;
  }
  if (fileSide.mode === GITLINK_MODE) {
    return { kind: "text", text: `Subproject commit ${fileSide.blob}\n` };
  }
  if (!isFullOid(fileSide.blob)) {
    throw new HistoryOutputError(`"${fileSide.blob}" is not a blob ID.`);
  }

  const sizeResult = await runPrivateGit(session.repository, ["cat-file", "-s", fileSide.blob], signal);
  const sizeBytes = Number(sizeResult.stdout.toString("utf8").trim());
  if (sizeBytes > COMPARISON_FILE_LIMIT_BYTES) {
    return nonText("oversize", sizeBytes, fileSide);
  }

  const blob = await runPrivateGit(session.repository, ["cat-file", "blob", fileSide.blob], signal);
  return decodeContent(blob.stdout, fileSide);
}

/** Text only when free of NUL bytes and valid UTF-8; bytes, line endings and BOMs are preserved exactly. */
function decodeContent(content: Buffer, fileSide: ComparisonFileSide): FileContentResult {
  if (content.includes(NUL_BYTE)) {
    return nonText("binary", content.length, fileSide);
  }
  if (!isUtf8(content)) {
    return nonText("invalidEncoding", content.length, fileSide);
  }
  return { kind: "text", text: content.toString("utf8") };
}

function nonText(reason: NonTextReason, sizeBytes: number, fileSide: ComparisonFileSide): FileContentResult {
  const details = `${sizeBytes} bytes, mode ${fileSide.mode}`;
  const limitMiB = COMPARISON_FILE_LIMIT_BYTES / (1024 * 1024);
  const explanations: Readonly<Record<NonTextReason, string>> = {
    binary: `Binary file (${details}); its content is not shown as text.`,
    invalidEncoding: `File is not valid UTF-8 text (${details}); its content is not shown.`,
    oversize: `File is larger than ${limitMiB} MiB (${details}); its content is not shown.`,
  };
  return { kind: "nonText", reason, explanation: explanations[reason], sizeBytes, mode: fileSide.mode };
}

function toComparisonFile({ change, isBinary }: DiffRecord): ComparisonFile {
  return {
    id: randomUUID(),
    status: change.status,
    base: fileSide(change.oldPath, change.oldOid, change.oldMode),
    result: fileSide(change.newPath, change.newOid, change.newMode),
    contentKind: contentKindOf(change, isBinary),
  };
}

/** A file that is a gitlink on either side is shown by its submodule commits. */
function contentKindOf(change: RawChange, isBinary: boolean): FileContentKind {
  const isGitlink = change.oldMode === GITLINK_MODE || change.newMode === GITLINK_MODE;
  if (isGitlink) {
    return "gitlink";
  }
  return isBinary ? "binary" : "text";
}

function fileSide(filePath: string, blob: string, mode: string): ComparisonFileSide | null {
  return mode === ABSENT_MODE ? null : { path: filePath, blob, mode };
}

/**
 * Parses `--raw --numstat -z` output: every raw record (`:` header, then one path, or two for a rename), followed by
 * one numstat record per change in the same order. Fields are NUL-terminated, so paths are never split.
 */
function parseDiffRecords(output: Buffer): readonly DiffRecord[] {
  const fields = output.toString("utf8").split("\0");
  const trailing = fields.pop();
  if (trailing !== "") {
    throw new HistoryOutputError("Git diff output is not NUL-terminated.");
  }

  const changes: RawChange[] = [];
  let position = 0;
  while (position < fields.length && fields[position]?.startsWith(":")) {
    const change = parseRawChange(fields, position);
    changes.push(change.value);
    position = change.next;
  }

  const binaryFlags: boolean[] = [];
  while (position < fields.length) {
    const numstat = fields[position] ?? "";
    binaryFlags.push(numstat.startsWith(BINARY_NUMSTAT_PREFIX));
    position += isRenameNumstat(numstat) ? RENAME_NUMSTAT_FIELD_COUNT : NUMSTAT_FIELD_COUNT;
  }

  const isComplete = position === fields.length && binaryFlags.length === changes.length;
  if (!isComplete) {
    throw new HistoryOutputError("Git diff output has mismatched raw and numstat records.");
  }
  return changes.map((change, index) => ({ change, isBinary: binaryFlags[index] === true }));
}

/** `added<TAB>deleted<TAB>path`; a rename leaves the path empty and lists old and new paths as the next two fields. */
function isRenameNumstat(numstat: string): boolean {
  const [added, deleted, ...pathParts] = numstat.split("\t");
  const isWellFormed = added !== undefined && deleted !== undefined && pathParts.length > 0;
  if (!isWellFormed) {
    throw new HistoryOutputError(`Unexpected numstat record "${numstat}".`);
  }
  return pathParts.join("\t") === "";
}

function parseRawChange(fields: readonly string[], position: number): ParsedRawChange {
  const [oldMode = "", newMode = "", oldOid = "", newOid = "", statusField = ""] = (fields[position] ?? "")
    .slice(1)
    .split(" ");
  const status = STATUS_BY_LETTER[statusField.charAt(0)];
  const oldPath = fields[position + 1];
  const isRename = status === "renamed";
  const newPath = isRename ? fields[position + 2] : oldPath;
  const hasValidHeader = [oldMode, newMode].every((mode) => MODE_PATTERN.test(mode)) && isFullOid(oldOid)
    && isFullOid(newOid);
  if (!hasValidHeader || status === undefined || oldPath === undefined || newPath === undefined) {
    throw new HistoryOutputError(`Unexpected diff record "${fields[position]}".`);
  }

  const value = { oldMode, newMode, oldOid, newOid, status, oldPath, newPath };
  return { value, next: position + (isRename ? RENAME_RAW_FIELD_COUNT : RAW_FIELD_COUNT) };
}
