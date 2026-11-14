import type { MergeSide } from "../../model/mergeChunks";
import type { NonConflictingScope } from "../../model/mergeSession";
import type { MergeClientData } from "../../render/html/mergeViewRenderer";

/**
 * Intents posted by `media/merge.js`. Indexes are checked against the merge state by the session itself.
 * Line edits are already on the page; a split or join carries `seq` for the {@link MergeLayoutUpdate} answering it.
 */
export type MergeMessage =
  | { readonly type: "applySide"; readonly chunk: number; readonly side: MergeSide }
  | { readonly type: "ignoreSide"; readonly chunk: number; readonly side: MergeSide }
  | { readonly type: "applyNonConflicting"; readonly scope: NonConflictingScope }
  | { readonly type: "acceptSide"; readonly side: MergeSide }
  | { readonly type: "editLine"; readonly line: number; readonly text: string }
  | { readonly type: "splitLine"; readonly line: number; readonly offset: number; readonly seq: number }
  | { readonly type: "joinWithPrevious"; readonly line: number; readonly seq: number }
  | { readonly type: "apply" }
  | { readonly type: "cancel" };

/** Posted to `media/merge.js` after a split or join: the chunk layout the edit left, to redraw tints and ribbons. */
export interface MergeLayoutUpdate {
  readonly type: "layout";
  readonly seq: number;
  readonly data: MergeClientData;
}

/** Longest line of text accepted from the webview. */
export const MAX_LINE_LENGTH = 1_000_000;

type Fields = Readonly<Record<string, unknown>>;

const SCHEMAS: Readonly<Record<MergeMessage["type"], (fields: Fields) => MergeMessage | null>> = {
  applySide: (fields) => parseChunkSide("applySide", fields),
  ignoreSide: (fields) => parseChunkSide("ignoreSide", fields),
  applyNonConflicting: parseNonConflicting,
  acceptSide: (fields) => (isSide(fields.side) ? { type: "acceptSide", side: fields.side } : null),
  editLine: parseEditLine,
  splitLine: parseSplitLine,
  joinWithPrevious: parseJoin,
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
  const isText = typeof text === "string" && text.length <= MAX_LINE_LENGTH && !/[\r\n]/.test(text);
  return isIndex(line) && isText ? { type: "editLine", line, text } : null;
}

function parseSplitLine(fields: Fields): MergeMessage | null {
  const { line, offset, seq } = fields;
  return isIndex(line) && isIndex(offset) && isIndex(seq) ? { type: "splitLine", line, offset, seq } : null;
}

function parseJoin(fields: Fields): MergeMessage | null {
  const { line, seq } = fields;
  return isIndex(line) && isIndex(seq) ? { type: "joinWithPrevious", line, seq } : null;
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
