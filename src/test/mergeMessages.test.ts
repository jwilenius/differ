import { describe, expect, it } from "vitest";
import { MAX_LINE_LENGTH, parseMergeMessage } from "../host/vscode/mergeMessages";

const FOCUS = { line: 2, offset: 3 };

describe("parseMergeMessage", () => {
  it.each([
    { type: "applySide", chunk: 0, side: "left" },
    { type: "ignoreSide", chunk: 4, side: "right" },
    { type: "applyNonConflicting", scope: "all" },
    { type: "applyNonConflicting", scope: "right" },
    { type: "acceptSide", side: "left" },
    { type: "editLine", line: 2, text: "const x = 1;" },
    { type: "splitLine", line: 2, offset: 3, focus: FOCUS },
    { type: "joinWithPrevious", line: 2, focus: FOCUS },
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
    ["a malformed focus", { type: "joinWithPrevious", line: 1, focus: { line: 0 } }],
    ["a focus with extra fields", { type: "joinWithPrevious", line: 1, focus: { line: 0, offset: 0, x: 1 } }],
  ])("rejects %s", (_label, message) => {
    expect(parseMergeMessage(message)).toBeNull();
  });
});
