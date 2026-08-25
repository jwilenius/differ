import { describe, expect, it } from "vitest";
import { parseConflicts } from "../core/conflictParser";
import { applyResolution, resolvedLines } from "../core/mergeResolver";
import type { ConflictSection } from "../core/types";

const document = [
  "before",
  "<<<<<<< HEAD",
  "mine",
  "||||||| base",
  "original",
  "=======",
  "theirs",
  ">>>>>>> feature",
  "after",
].join("\n");

const conflictOf = (text: string): ConflictSection =>
  parseConflicts(text).find((section) => section.kind === "conflict") as ConflictSection;

describe("resolvedLines", () => {
  it.each([
    ["local", ["mine"]],
    ["remote", ["theirs"]],
    ["base", ["original"]],
    ["localThenRemote", ["mine", "theirs"]],
    ["remoteThenLocal", ["theirs", "mine"]],
  ] as const)("returns the %s lines", (resolution, expected) => {
    expect(resolvedLines(conflictOf(document), resolution)).toEqual(expected);
  });
});

describe("applyResolution", () => {
  it("replaces the conflict and its markers with the chosen side", () => {
    const result = applyResolution(document, conflictOf(document), "local");

    expect(result).toBe(["before", "mine", "after"].join("\n"));
  });

  it("leaves no markers behind", () => {
    const result = applyResolution(document, conflictOf(document), "localThenRemote");

    expect(result).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
    expect(result.split("\n")).toEqual(["before", "mine", "theirs", "after"]);
  });

  it("preserves surrounding text exactly", () => {
    const result = applyResolution(document, conflictOf(document), "remote");

    expect(result.startsWith("before\n")).toBe(true);
    expect(result.endsWith("\nafter")).toBe(true);
  });
});
