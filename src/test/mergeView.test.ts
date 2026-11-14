import { describe, expect, it } from "vitest";
import { applySide, editLine, ignoreSide, startMerge } from "../model/mergeSession";
import { describeMerge } from "../model/mergeView";

const WORDS = { wordLevel: true };

// base:  a, "let x = 1", c, d    left: modifies line 1    right: adds after c, and conflicts nowhere
const BASE = "a\nlet x = 1\nc\nd";
const LEFT = "a\nlet x = 2\nc\nd";
const RIGHT = "a\nlet x = 1\nc\nnew\nd";

describe("describeMerge", () => {
  it("tints each chunk by how its side changed it", () => {
    const chunks = describeMerge(startMerge(BASE, LEFT, RIGHT), WORDS);

    expect(chunks.map((chunk) => chunk.tint)).toEqual(["modified", "added"]);
    expect(chunks[0].left).toMatchObject({ range: { start: 1, end: 2 }, resolution: "pending" });
    expect(chunks[0].right).toMatchObject({ resolution: null, words: [] });
    expect(chunks[1].right.range).toEqual({ start: 3, end: 4 });
  });

  it("marks the changed words on the side and the base words they replace in the result", () => {
    const [modified] = describeMerge(startMerge(BASE, LEFT, RIGHT), WORDS);

    expect(modified.left.words).toEqual([{ line: 1, spans: [{ start: 8, end: 9 }] }]);
    expect(modified.resultWords).toEqual([{ line: 1, spans: [{ start: 8, end: 9 }] }]);
  });

  it("drops the result words once the result no longer holds the base lines", () => {
    const [modified] = describeMerge(editLine(startMerge(BASE, LEFT, RIGHT), 1, "let x = 3"), WORDS);

    expect(modified.left.words).not.toEqual([]);
    expect(modified.resultWords).toEqual([]);
  });

  it("shows no words without word-level highlighting or once a side is decided", () => {
    const state = startMerge(BASE, LEFT, RIGHT);

    expect(describeMerge(state, { wordLevel: false })[0]).toMatchObject({ resultWords: [], left: { words: [] } });
    const applied = describeMerge(applySide(state, 0, "left"), WORDS)[0];
    expect(applied).toMatchObject({ isResolved: true, resultWords: [], left: { resolution: "applied", words: [] } });
  });

  it("tints a conflict as one and keeps it unresolved until both sides are decided", () => {
    const state = startMerge("a\nb\nc", "a\nL\nc", "a\nR\nc");
    const halfway = ignoreSide(state, 0, "left");

    expect(describeMerge(state, WORDS)[0]).toMatchObject({ tint: "conflict", isResolved: false, resultWords: [] });
    expect(describeMerge(halfway, WORDS)[0]).toMatchObject({ isResolved: false, left: { resolution: "ignored" } });
  });
});
