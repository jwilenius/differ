import { describe, expect, it } from "vitest";
import { MAX_LINE_LENGTH, MAX_REPLACED_LINES, parseMergeMessage } from "../host/vscode/mergeMessages";

describe("parseMergeMessage", () => {
  it.each([
    { type: "applySide", page: 1, chunk: 0, side: "left" },
    { type: "ignoreSide", page: 1, chunk: 4, side: "right" },
    { type: "applyNonConflicting", page: 1, scope: "all" },
    { type: "applyNonConflicting", page: 1, scope: "right" },
    { type: "acceptSide", page: 1, side: "left" },
    { type: "editLine", page: 1, line: 2, text: "const x = 1;" },
    { type: "splitLine", page: 1, line: 2, offset: 3, seq: 1 },
    { type: "joinWithPrevious", page: 1, line: 2, seq: 7 },
    { type: "replaceLines", page: 1, line: 2, count: 2, lines: ["a", "", "b"], seq: 3 },
    { type: "apply", page: 1 },
    { type: "cancel", page: 1 },
    { type: "undo", page: 1 },
    { type: "redo", page: 1 },
    { type: "redrawReady", page: 1, caret: null },
    { type: "redrawReady", page: 1, caret: { line: 3, column: 0 } },
  ])("accepts $type", (message) => {
    const parsed = parseMergeMessage(message);

    expect(parsed).toEqual(message);
    expect(parsed).not.toBe(message);
  });

  it.each([
    ["a non-object", "apply"],
    ["an unknown type", { type: "resolve", page: 1 }],
    ["a missing page number", { type: "apply" }],
    ["a fractional page number", { type: "cancel", page: 1.5 }],
    ["an inherited type name", { type: "toString", page: 1 }],
    ["an extra field", { type: "apply", page: 1, extra: 1 }],
    ["a missing field", { type: "applySide", page: 1, chunk: 0 }],
    ["a negative index", { type: "applySide", page: 1, chunk: -1, side: "left" }],
    ["a fractional index", { type: "ignoreSide", page: 1, chunk: 1.5, side: "left" }],
    ["an unknown side", { type: "acceptSide", page: 1, side: "base" }],
    ["an unknown scope", { type: "applyNonConflicting", page: 1, scope: "both" }],
    ["text with a line break", { type: "editLine", page: 1, line: 0, text: "a\nb" }],
    ["overlong text", { type: "editLine", page: 1, line: 0, text: "x".repeat(MAX_LINE_LENGTH + 1) }],
    ["a missing sequence number", { type: "joinWithPrevious", page: 1, line: 1 }],
    ["a fractional sequence number", { type: "splitLine", page: 1, line: 1, offset: 0, seq: 0.5 }],
    ["no lines to replace", { type: "replaceLines", page: 1, line: 0, count: 0, lines: ["a"], seq: 1 }],
    ["no replacement lines", { type: "replaceLines", page: 1, line: 0, count: 1, lines: [], seq: 1 }],
    ["replacement lines that are not a list", { type: "replaceLines", page: 1, line: 0, count: 1, lines: "a", seq: 1 }],
    ["replacement lines with a hole", { type: "replaceLines", page: 1, line: 0, count: 1, lines: new Array<string>(2), seq: 1 }],
    ["a replacement line that is not text", { type: "replaceLines", page: 1, line: 0, count: 1, lines: ["a", 1], seq: 1 }],
    ["a replacement line with a line break", { type: "replaceLines", page: 1, line: 0, count: 1, lines: ["a", "b\rc"], seq: 1 }],
    ["an overlong replacement line", { type: "replaceLines", page: 1, line: 0, count: 1, lines: ["x".repeat(MAX_LINE_LENGTH + 1)], seq: 1 }],
    ["a redraw answer without a caret", { type: "redrawReady", page: 1 }],
    ["a caret that is not a position", { type: "redrawReady", page: 1, caret: 3 }],
    ["a caret at a negative column", { type: "redrawReady", page: 1, caret: { line: 0, column: -1 } }],
    ["a caret with an extra field", { type: "redrawReady", page: 1, caret: { line: 0, column: 0, side: "left" } }],
    ["too many replacement lines", { type: "replaceLines", page: 1, line: 0, count: 1, lines: Array<string>(MAX_REPLACED_LINES + 1).fill(""), seq: 1 }],
  ])("rejects %s", (_label, message) => {
    expect(parseMergeMessage(message)).toBeNull();
  });
});
