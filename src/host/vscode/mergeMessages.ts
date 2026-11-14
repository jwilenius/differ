import type { MergeSide } from "../../model/mergeChunks";
import type { NonConflictingScope } from "../../model/mergeSession";
import type { MergeClientData } from "../../render/html/mergeViewRenderer";

/**
 * Intents posted by `media/merge.js`. Indexes are checked against the merge state by the session itself.
 * Line edits are already on the page; an edit that adds or removes lines carries `seq` for the
 * {@link MergeLayoutUpdate} answering it.
 */
export type MergeMessage =
  | { readonly type: "applySide"; readonly chunk: number; readonly side: MergeSide }
  | { readonly type: "ignoreSide"; readonly chunk: number; readonly side: MergeSide }
  | { readonly type: "applyNonConflicting"; readonly scope: NonConflictingScope }
  | { readonly type: "acceptSide"; readonly side: MergeSide }
  | { readonly type: "editLine"; readonly line: number; readonly text: string }
  | { readonly type: "splitLine"; readonly line: number; readonly offset: number; readonly seq: number }
  | { readonly type: "joinWithPrevious"; readonly line: number; readonly seq: number }
  | { readonly type: "replaceLine"; readonly line: number; readonly lines: readonly string[]; readonly seq: number }
  | { readonly type: "apply" }
  | { readonly type: "cancel" };

/** Posted to `media/merge.js` after an edit that adds or removes lines: the chunk layout the edit left, to redraw tints and ribbons. */
export interface MergeLayoutUpdate {
  readonly type: "layout";
  readonly seq: number;
  readonly data: MergeClientData;
}

/** Longest line of text accepted from the webview. */
export const MAX_LINE_LENGTH = 1_000_000;

/** Most lines accepted in place of one result line, as a paste brings them. */
export const MAX_REPLACED_LINES = 100_000;

type Fields = Readonly<Record<string, unknown>>;

const SCHEMAS: Readonly<Record<MergeMessage["type"], (fields: Fields) => MergeMessage | null>> = {
  applySide: (fields) => parseChunkSide("applySide", fields),
  ignoreSide: (fields) => parseChunkSide("ignoreSide", fields),
  applyNonConflicting: parseNonConflicting,
  acceptSide: (fields) => (isSide(fields.side) ? { type: "acceptSide", side: fields.side } : null),
  editLine: parseEditLine,
  splitLine: parseSplitLine,
  joinWithPrevious: parseJoin,
  replaceLine: parseReplaceLine,
  apply: () => ({ type: "apply" }),
  cancel: () => ({ type: "cancel" }),
};

const FIELDS: Readonly<Record<MergeMessage["type"], readonly string[]>> = {
  applySide: ["chunk", "side"],
  ignoreSide: ["chunk", "side"],
  applyNonConflicting: ["scope"],
  acceptSide: ["side"],
  editLine: ["line", "text"],
  splitLine: ["line", "offset", "seq"],
  joinWithPrevious: ["line", "seq"],
  replaceLine: ["line", "lines", "seq"],
  apply: [],
  cancel: [],
};

/** Returns a freshly built message when `value` has exactly the fields of one known type with valid values, otherwise null. */
export function parseMergeMessage(value: unknown): MergeMessage | null {
  if (!isRecord(value) || typeof value.type !== "string" || !Object.hasOwn(SCHEMAS, value.type)) {
    return null;
  }
  const type = value.type as MergeMessage["type"];
  const expected = ["type", ...FIELDS[type]];
  const hasExactFields = Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
  return hasExactFields ? SCHEMAS[type](value) : null;
}

function parseChunkSide(type: "applySide" | "ignoreSide", fields: Fields): MergeMessage | null {
  const { chunk, side } = fields;
  return isIndex(chunk) && isSide(side) ? { type, chunk, side } : null;
}

function parseNonConflicting(fields: Fields): MergeMessage | null {
  const { scope } = fields;
  const isScope = scope === "all" || isSide(scope);
  return isScope ? { type: "applyNonConflicting", scope } : null;
}

function parseEditLine(fields: Fields): MergeMessage | null {
  const { line, text } = fields;
  return isIndex(line) && isLineText(text) ? { type: "editLine", line, text } : null;
}

function parseSplitLine(fields: Fields): MergeMessage | null {
  const { line, offset, seq } = fields;
  return isIndex(line) && isIndex(offset) && isIndex(seq) ? { type: "splitLine", line, offset, seq } : null;
}

function parseJoin(fields: Fields): MergeMessage | null {
  const { line, seq } = fields;
  return isIndex(line) && isIndex(seq) ? { type: "joinWithPrevious", line, seq } : null;
}

function parseReplaceLine(fields: Fields): MergeMessage | null {
  const { line, lines, seq } = fields;
  return isIndex(line) && isLineList(lines) && isIndex(seq) ? { type: "replaceLine", line, lines: [...lines], seq } : null;
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
