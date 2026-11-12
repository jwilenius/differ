import { describe, expect, it } from "vitest";
import { buildTwoWayDiff, MAX_WORD_DIFF_CHARS } from "../model/twoWayDiff";

const WORDS = { wordLevel: true };

describe("buildTwoWayDiff", () => {
  it("reports no blocks for identical texts", () => {
    const diff = buildTwoWayDiff("a\nb\n", "a\nb\n", WORDS);

    expect(diff).toEqual({ blocks: [], baseLineCount: 3, resultLineCount: 3 });
  });

  it("classifies an insertion as added with an empty base range at the insertion point", () => {
    const diff = buildTwoWayDiff("a\nd", "a\nb\nc\nd", WORDS);

    expect(diff.blocks).toEqual([
      { kind: "added", base: { start: 1, end: 1 }, result: { start: 1, end: 3 }, baseWords: [], resultWords: [] },
    ]);
  });

  it("classifies a removal as deleted with an empty result range", () => {
    const diff = buildTwoWayDiff("a\nb\nc", "a\nc", WORDS);

    expect(diff.blocks).toEqual([
      { kind: "deleted", base: { start: 1, end: 2 }, result: { start: 1, end: 1 }, baseWords: [], resultWords: [] },
    ]);
  });

  it("keeps the line counts of each side, a trailing newline adding an empty last line", () => {
    const diff = buildTwoWayDiff("a\nb\n", "a", WORDS);

    expect(diff.baseLineCount).toBe(3);
    expect(diff.resultLineCount).toBe(1);
  });

  it("marks changed words on both sides of a modified line", () => {
    const diff = buildTwoWayDiff("keep\nlet value = 1;\nkeep", "keep\nlet value = 22;\nkeep", WORDS);

    expect(diff.blocks).toEqual([
      {
        kind: "modified",
        base: { start: 1, end: 2 },
        result: { start: 1, end: 2 },
        baseWords: [{ line: 1, spans: [{ start: 12, end: 13 }] }],
        resultWords: [{ line: 1, spans: [{ start: 12, end: 14 }] }],
      },
    ]);
  });

  it("maps word spans to whole-text line numbers when the block has unequal line counts", () => {
    const diff = buildTwoWayDiff("x\nold one\nz", "x\nnew one\nextra line\nz", WORDS);
    const [block] = diff.blocks;

    expect(block.kind).toBe("modified");
    expect(block.baseWords).toEqual([{ line: 1, spans: [{ start: 0, end: 3 }] }]);
    expect(block.resultWords.map((entry) => entry.line)).toEqual([1, 2]);
    expect(block.resultWords[0].spans).toEqual([{ start: 0, end: 3 }]);
  });

  it("never lets a span cross the end of its line", () => {
    const diff = buildTwoWayDiff("aa bb\ncc", "aa xx\nyyy", WORDS);
    const [block] = diff.blocks;

    expect(block.baseWords).toEqual([
      { line: 0, spans: [{ start: 3, end: 5 }] },
      { line: 1, spans: [{ start: 0, end: 2 }] },
    ]);
    expect(block.resultWords).toEqual([
      { line: 0, spans: [{ start: 3, end: 5 }] },
      { line: 1, spans: [{ start: 0, end: 3 }] },
    ]);
  });

  it("omits word spans when word-level highlighting is off", () => {
    const diff = buildTwoWayDiff("a = 1", "a = 2", { wordLevel: false });

    expect(diff.blocks[0]).toMatchObject({ kind: "modified", baseWords: [], resultWords: [] });
  });

  it("skips word spans for a block too large to word-diff", () => {
    const longLine = "x".repeat(MAX_WORD_DIFF_CHARS / 2);
    const diff = buildTwoWayDiff(`${longLine}a`, `${longLine}b`, WORDS);

    expect(diff.blocks[0]).toMatchObject({ kind: "modified", baseWords: [], resultWords: [] });
  });

  it("reports separate blocks in order", () => {
    const diff = buildTwoWayDiff("a\nb\nc\nd\ne", "a\nB\nc\nd", WORDS);

    expect(diff.blocks.map((block) => [block.kind, block.base, block.result])).toEqual([
      ["modified", { start: 1, end: 2 }, { start: 1, end: 2 }],
      ["deleted", { start: 4, end: 5 }, { start: 4, end: 4 }],
    ]);
  });
});
