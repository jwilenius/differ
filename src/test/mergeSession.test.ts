import { describe, expect, it } from "vitest";
import { buildMergeChunks } from "../model/mergeChunks";
import {
  acceptSide,
  applyNonConflicting,
  applySide,
  editLine,
  ignoreSide,
  isChunkResolved,
  joinWithPrevious,
  resultText,
  splitLine,
  startMerge,
  tallyMerge,
} from "../model/mergeSession";

const lines = (text: string): string[] => text.split("\n");

// base:  a b c d e f g
// left:  changes b, adds X after e            (two left-only chunks)
// right: changes d, deletes g                 (two right-only chunks)
const BASE = "a\nb\nc\nd\ne\nf\ng";
const LEFT = "a\nB\nc\nd\ne\nX\nf\ng";
const RIGHT = "a\nb\nc\nD\ne\nf";

// Both sides change line b, differently: one conflict, plus a shared change of d.
const CONFLICT_BASE = "a\nb\nc\nd\ne";
const CONFLICT_LEFT = "a\nL1\nL2\nc\nD\ne";
const CONFLICT_RIGHT = "a\nR\nc\nD\ne";

describe("buildMergeChunks", () => {
  it("finds one chunk per change when the sides do not touch", () => {
    const chunks = buildMergeChunks(lines(BASE), lines(LEFT), lines(RIGHT));

    expect(chunks).toEqual([
      { base: { start: 1, end: 2 }, left: { start: 1, end: 2 }, right: { start: 1, end: 2 }, leftKind: "modified", rightKind: null, isConflict: false },
      { base: { start: 3, end: 4 }, left: { start: 3, end: 4 }, right: { start: 3, end: 4 }, leftKind: null, rightKind: "modified", isConflict: false },
      { base: { start: 5, end: 5 }, left: { start: 5, end: 6 }, right: { start: 5, end: 5 }, leftKind: "added", rightKind: null, isConflict: false },
      { base: { start: 6, end: 7 }, left: { start: 7, end: 8 }, right: { start: 6, end: 6 }, leftKind: null, rightKind: "deleted", isConflict: false },
    ]);
  });

  it("marks overlapping different changes as a conflict and identical ones as shared", () => {
    const chunks = buildMergeChunks(lines(CONFLICT_BASE), lines(CONFLICT_LEFT), lines(CONFLICT_RIGHT));

    expect(chunks).toEqual([
      { base: { start: 1, end: 2 }, left: { start: 1, end: 3 }, right: { start: 1, end: 2 }, leftKind: "modified", rightKind: "modified", isConflict: true },
      { base: { start: 3, end: 4 }, left: { start: 4, end: 5 }, right: { start: 3, end: 4 }, leftKind: "modified", rightKind: "modified", isConflict: false },
    ]);
  });

  it("widens each side over the base lines its partner changed", () => {
    // Left changes b, right changes b and c: one chunk over b..c on both sides.
    const chunks = buildMergeChunks(lines("a\nb\nc\nd"), lines("a\nB\nc\nd"), lines("a\nb2\nc2\nd"));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].base).toEqual({ start: 1, end: 3 });
    expect(chunks[0].left).toEqual({ start: 1, end: 3 });
    expect(chunks[0].right).toEqual({ start: 1, end: 3 });
    expect(chunks[0].isConflict).toBe(true);
  });
});

describe("merge session", () => {
  it("starts from the base text with every change pending", () => {
    const state = startMerge(BASE, LEFT, RIGHT);

    expect(resultText(state)).toBe(BASE);
    expect(tallyMerge(state)).toEqual({ changes: 4, conflicts: 0 });
    expect(state.isModified).toBe(false);
  });

  it("applies a side and shifts the chunks after it", () => {
    const state = applySide(startMerge(BASE, LEFT, RIGHT), 2, "left");

    expect(resultText(state)).toBe("a\nb\nc\nd\ne\nX\nf\ng");
    expect(state.chunks[2].result).toEqual({ start: 5, end: 6 });
    expect(state.chunks[3].result).toEqual({ start: 7, end: 8 });
    expect(isChunkResolved(state.chunks[2])).toBe(true);
    expect(state.isModified).toBe(true);
  });

  it("reaches both sides' version when all non-conflicting changes are applied", () => {
    const state = applyNonConflicting(startMerge(BASE, LEFT, RIGHT), "all");

    expect(resultText(state)).toBe("a\nB\nc\nD\ne\nX\nf");
    expect(tallyMerge(state)).toEqual({ changes: 0, conflicts: 0 });
  });

  it("applies non-conflicting changes from one side only", () => {
    const state = applyNonConflicting(startMerge(BASE, LEFT, RIGHT), "right");

    expect(resultText(state)).toBe("a\nb\nc\nD\ne\nf");
    expect(tallyMerge(state).changes).toBe(2);
  });

  it("leaves conflicts alone when applying non-conflicting changes", () => {
    const state = applyNonConflicting(startMerge(CONFLICT_BASE, CONFLICT_LEFT, CONFLICT_RIGHT), "all");

    expect(resultText(state)).toBe("a\nb\nc\nD\ne");
    expect(tallyMerge(state)).toEqual({ changes: 0, conflicts: 1 });
  });

  it("appends the second side applied to a conflict after the first", () => {
    const leftFirst = applySide(startMerge(CONFLICT_BASE, CONFLICT_LEFT, CONFLICT_RIGHT), 0, "left");
    const both = applySide(leftFirst, 0, "right");

    expect(resultText(leftFirst)).toBe("a\nL1\nL2\nc\nd\ne");
    expect(resultText(both)).toBe("a\nL1\nL2\nR\nc\nd\ne");
    expect(both.chunks[0].result).toEqual({ start: 1, end: 4 });
    expect(both.chunks[1].result).toEqual({ start: 5, end: 6 });
    expect(isChunkResolved(both.chunks[0])).toBe(true);
  });

  it("resolves a conflict by applying one side and ignoring the other", () => {
    const ignored = ignoreSide(startMerge(CONFLICT_BASE, CONFLICT_LEFT, CONFLICT_RIGHT), 0, "left");
    const state = applySide(ignored, 0, "right");

    expect(isChunkResolved(ignored.chunks[0])).toBe(false);
    expect(ignored.isModified).toBe(true);
    expect(resultText(state)).toBe("a\nR\nc\nd\ne");
    expect(isChunkResolved(state.chunks[0])).toBe(true);
  });

  it("settles a shared change with one decision", () => {
    const state = applySide(startMerge(CONFLICT_BASE, CONFLICT_LEFT, CONFLICT_RIGHT), 1, "right");

    expect(state.chunks[1]).toMatchObject({ left: "applied", right: "applied" });
    expect(resultText(state)).toBe("a\nb\nc\nD\ne");
  });

  it("ignores repeated actions on a side already decided", () => {
    const once = applySide(startMerge(BASE, LEFT, RIGHT), 0, "left");

    expect(applySide(once, 0, "left")).toBe(once);
    expect(ignoreSide(once, 0, "left")).toBe(once);
    expect(applySide(once, 0, "right")).toBe(once);
  });

  it("accepts one side's whole file", () => {
    const state = acceptSide(startMerge(CONFLICT_BASE, CONFLICT_LEFT, CONFLICT_RIGHT), "right");

    expect(resultText(state)).toBe(CONFLICT_RIGHT);
    expect(tallyMerge(state)).toEqual({ changes: 0, conflicts: 0 });
    expect(state.chunks[0]).toMatchObject({ left: "ignored", right: "applied", result: { start: 1, end: 2 } });
  });

  it("moves chunks when lines are edited, split and joined", () => {
    const start = startMerge(BASE, LEFT, RIGHT);

    const split = splitLine(start, 0, 0);
    expect(resultText(split)).toBe("\na\nb\nc\nd\ne\nf\ng");
    expect(split.chunks[0].result).toEqual({ start: 2, end: 3 });

    const joined = joinWithPrevious(split, 1);
    expect(resultText(joined)).toBe(BASE);
    expect(joined.chunks[0].result).toEqual({ start: 1, end: 2 });

    const grown = splitLine(start, 1, 1);
    expect(resultText(grown)).toBe("a\nb\n\nc\nd\ne\nf\ng");
    expect(grown.chunks[0].result).toEqual({ start: 1, end: 3 });
    expect(grown.chunks[1].result).toEqual({ start: 4, end: 5 });

    const edited = editLine(start, 2, "C");
    expect(resultText(edited)).toBe("a\nb\nC\nd\ne\nf\ng");
    expect(edited.chunks.map((chunkState) => chunkState.result)).toEqual(start.chunks.map((chunkState) => chunkState.result));
  });

  it("ignores edits outside the result", () => {
    const start = startMerge(BASE, LEFT, RIGHT);

    expect(editLine(start, 99, "x")).toBe(start);
    expect(splitLine(start, -1, 0)).toBe(start);
    expect(joinWithPrevious(start, 0)).toBe(start);
  });
});
