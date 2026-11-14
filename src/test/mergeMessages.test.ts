import { describe, expect, it } from "vitest";
import { MAX_LINE_LENGTH, MAX_REPLACED_LINES, parseMergeMessage } from "../host/vscode/mergeMessages";

describe("parseMergeMessage", () => {
  it.each([
    { type: "applySide", chunk: 0, side: "left" },
    { type: "ignoreSide", chunk: 4, side: "right" },
    { type: "applyNonConflicting", scope: "all" },
    { type: "applyNonConflicting", scope: "right" },
    { type: "acceptSide", side: "left" },
    { type: "editLine", line: 2, text: "const x = 1;" },
    { type: "splitLine", line: 2, offset: 3, seq: 1 },
    { type: "joinWithPrevious", line: 2, seq: 7 },
    { type: "replaceLine", line: 2, lines: ["a", "", "b"], seq: 3 },
    { type: "apply" },
    { type: "cancel" },
  ])("accepts $type", (message) => {
    const parsed = parseMergeMessage(message);

    expect(parsed).toEqual(message);
    expect(parsed).not.toBe(message);
  });

  it.each([
    ["a non-object", "apply"],
    ["an unknown type", { type: "resolve" }],
    ["an inherited type name", { type: "toString" }],
    ["an extra field", { type: "apply", extra: 1 }],
    ["a missing field", { type: "applySide", chunk: 0 }],
    ["a negative index", { type: "applySide", chunk: -1, side: "left" }],
    ["a fractional index", { type: "ignoreSide", chunk: 1.5, side: "left" }],
    ["an unknown side", { type: "acceptSide", side: "base" }],
    ["an unknown scope", { type: "applyNonConflicting", scope: "both" }],
    ["text with a line break", { type: "editLine", line: 0, text: "a\nb" }],
    ["overlong text", { type: "editLine", line: 0, text: "x".repeat(MAX_LINE_LENGTH + 1) }],
    ["a missing sequence number", { type: "joinWithPrevious", line: 1 }],
    ["a fractional sequence number", { type: "splitLine", line: 1, offset: 0, seq: 0.5 }],
    ["no replacement lines", { type: "replaceLine", line: 0, lines: [], seq: 1 }],
    ["replacement lines that are not a list", { type: "replaceLine", line: 0, lines: "a", seq: 1 }],
    ["replacement lines with a hole", { type: "replaceLine", line: 0, lines: new Array<string>(2), seq: 1 }],
    ["a replacement line that is not text", { type: "replaceLine", line: 0, lines: ["a", 1], seq: 1 }],
    ["a replacement line with a line break", { type: "replaceLine", line: 0, lines: ["a", "b\rc"], seq: 1 }],
    ["an overlong replacement line", { type: "replaceLine", line: 0, lines: ["x".repeat(MAX_LINE_LENGTH + 1)], seq: 1 }],
    ["too many replacement lines", { type: "replaceLine", line: 0, lines: Array<string>(MAX_REPLACED_LINES + 1).fill(""), seq: 1 }],
  ])("rejects %s", (_label, message) => {
    expect(parseMergeMessage(message)).toBeNull();
  });
});
