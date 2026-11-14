import type { MergeSide } from "../../model/mergeChunks";
import type { NonConflictingScope } from "../../model/mergeSession";
import type { MergeClientData } from "../../render/html/mergeViewRenderer";

/**
 * What `media/merge.js` asks for. Indexes are checked against the merge state by the session itself.
 * Line edits are already on the page; an edit that adds or removes lines carries `seq` for the
 * {@link MergeLayoutUpdate} answering it.
 */
export type MergeIntent =
  | { readonly type: "applySide"; readonly chunk: number; readonly side: MergeSide }
  | { readonly type: "ignoreSide"; readonly chunk: number; readonly side: MergeSide }
  | { readonly type: "applyNonConflicting"; readonly scope: NonConflictingScope }
  | { readonly type: "acceptSide"; readonly side: MergeSide }
  | { readonly type: "editLine"; readonly line: number; readonly text: string }
  | { readonly type: "splitLine"; readonly line: number; readonly offset: number; readonly seq: number }
  | { readonly type: "joinWithPrevious"; readonly line: number; readonly seq: number }
  | { readonly type: "replaceLines"; readonly line: number; readonly count: number; readonly lines: readonly string[]; readonly seq: number }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  | { readonly type: "apply" }
  | { readonly type: "cancel" };

/** An intent that changes result lines on the page itself. */
export type LineEdit = Extract<MergeIntent, { type: "editLine" | "splitLine" | "joinWithPrevious" | "replaceLines" }>;

/** An intent stamped with the number of the page that posted it; a replaced page's messages arrive late, about lines it no longer shows. */
export type MergeMessage = MergeIntent & { readonly page: number };

/** Posted to `media/merge.js` after an edit that adds or removes lines: the chunk layout the edit left, to redraw tints and ribbons. */
export interface MergeLayoutUpdate {
  readonly type: "layout";
  readonly page: number;
  readonly seq: number;
  readonly data: MergeClientData;
}

/**
 * Posted to `media/merge.js` when the host starts redrawing the page: it sends the edit it holds back and
 * stops taking edits, which would be lost with it.
 */
export interface MergeRedrawNotice {
  readonly type: "redrawing";
  readonly page: number;
}

/**
 * Posted to `media/merge.js` after the host highlighted the result again following a line edit: the lines whose
 * markup changed, which the page takes where its text still matches. `seq` is that of the latest numbered edit
 * the highlighting includes; the page moves the lines through the edits it has numbered since.
 */
export interface MergeHighlightUpdate {
  readonly type: "highlight";
  readonly page: number;
  readonly seq: number;
  /** The result's token stylesheet, in place of the page's; it keeps every index the page's lines use. */
  readonly styles: string;
  readonly lines: readonly { readonly line: number; readonly text: string; readonly html: string }[];
}

/** From `line`, `removed` result lines gave way to `added`. */
export interface EditedLines {
  readonly line: number;
  readonly removed: number;
  readonly added: number;
}

/** The result lines a line edit replaces; `editedLines` in `media/mergeLines.js` reckons them alike. */
export function editedLines(edit: LineEdit): EditedLines {
  switch (edit.type) {
    case "editLine":
      return { line: edit.line, removed: 1, added: 1 };
    case "splitLine":
      return { line: edit.line, removed: 1, added: 2 };
    case "joinWithPrevious":
      return { line: edit.line - 1, removed: 2, added: 1 };
    case "replaceLines":
      return { line: edit.line, removed: edit.count, added: edit.lines.length };
  }
}

/** Longest line of text accepted from the webview. */
export const MAX_LINE_LENGTH = 1_000_000;

/** Most lines accepted in place of result lines, as a paste brings them. */
export const MAX_REPLACED_LINES = 100_000;

type Fields = Readonly<Record<string, unknown>>;

const SCHEMAS: Readonly<Record<MergeIntent["type"], (fields: Fields) => MergeIntent | null>> = {
  applySide: (fields) => parseChunkSide("applySide", fields),
  ignoreSide: (fields) => parseChunkSide("ignoreSide", fields),
  applyNonConflicting: parseNonConflicting,
  acceptSide: (fields) => (isSide(fields.side) ? { type: "acceptSide", side: fields.side } : null),
  editLine: parseEditLine,
  splitLine: parseSplitLine,
  joinWithPrevious: parseJoin,
  replaceLines: parseReplaceLines,
  undo: () => ({ type: "undo" }),
  redo: () => ({ type: "redo" }),
  apply: () => ({ type: "apply" }),
  cancel: () => ({ type: "cancel" }),
};

const FIELDS: Readonly<Record<MergeIntent["type"], readonly string[]>> = {
  applySide: ["chunk", "side"],
  ignoreSide: ["chunk", "side"],
  applyNonConflicting: ["scope"],
  acceptSide: ["side"],
  editLine: ["line", "text"],
  splitLine: ["line", "offset", "seq"],
  joinWithPrevious: ["line", "seq"],
  replaceLines: ["line", "count", "lines", "seq"],
  undo: [],
  redo: [],
  apply: [],
  cancel: [],
};

/** Returns a freshly built message when `value` has a page number and exactly the fields of one known type with valid values, otherwise null. */
export function parseMergeMessage(value: unknown): MergeMessage | null {
  if (!isRecord(value) || typeof value.type !== "string" || !Object.hasOwn(SCHEMAS, value.type)) {
    return null;
  }
  const type = value.type as MergeIntent["type"];
  const { page } = value;
  const expected = ["type", "page", ...FIELDS[type]];
  const hasExactFields = Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
  if (!hasExactFields || !isIndex(page)) {
    return null;
  }
  const intent = SCHEMAS[type](value);
  return intent === null ? null : { ...intent, page };
}

function parseChunkSide(type: "applySide" | "ignoreSide", fields: Fields): MergeIntent | null {
  const { chunk, side } = fields;
  return isIndex(chunk) && isSide(side) ? { type, chunk, side } : null;
}

function parseNonConflicting(fields: Fields): MergeIntent | null {
  const { scope } = fields;
  const isScope = scope === "all" || isSide(scope);
  return isScope ? { type: "applyNonConflicting", scope } : null;
}

function parseEditLine(fields: Fields): MergeIntent | null {
  const { line, text } = fields;
  return isIndex(line) && isLineText(text) ? { type: "editLine", line, text } : null;
}

function parseSplitLine(fields: Fields): MergeIntent | null {
  const { line, offset, seq } = fields;
  return isIndex(line) && isIndex(offset) && isIndex(seq) ? { type: "splitLine", line, offset, seq } : null;
}

function parseJoin(fields: Fields): MergeIntent | null {
  const { line, seq } = fields;
  return isIndex(line) && isIndex(seq) ? { type: "joinWithPrevious", line, seq } : null;
}

function parseReplaceLines(fields: Fields): MergeIntent | null {
  const { line, count, lines, seq } = fields;
  const isValid = isIndex(line) && isIndex(count) && count > 0 && isLineList(lines) && isIndex(seq);
  return isValid ? { type: "replaceLines", line, count, lines: [...lines], seq } : null;
}

/** `every` skips the holes a structured clone keeps, so the list is copied densely first. */
function isLineList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_REPLACED_LINES && Array.from(value).every(isLineText);
}

function isLineText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_LINE_LENGTH && !/[\r\n]/.test(value);
}

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSide(value: unknown): value is MergeSide {
  return value === "left" || value === "right";
}
