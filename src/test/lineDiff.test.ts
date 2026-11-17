import { describe, expect, it } from "vitest";
import { diffLines } from "../core/lineDiff";

/** `count` lines that match no line of another call with a different `tag`. */
function distinctLines(tag: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${tag} ${index}`);
}

/** `count` lines where every twelfth calls `name`, so renaming it changes those lines only. */
function linesCalling(name: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => (index % 12 === 0 ? `  ${name}(${index});` : `  line ${index};`));
}

describe("diffLines", () => {
  it("reports a modified line with the positions of the lines around it", () => {
    const diff = diffLines(["a", "b", "c"], ["a", "x", "y", "c"]);

    expect(diff.hunks).toEqual([{ baseStart: 1, baseEnd: 2, sideStart: 1, sideEnd: 3 }]);
    expect(diff.startPosition).toEqual([0, 1, 1, 4]);
    expect(diff.endPosition).toEqual([0, 1, 3, 4]);
  });

  it("keeps separate hunks for small changes far apart", () => {
    const diff = diffLines(["a", "b", "c", "d", "e"], ["a", "B", "c", "d", "e", "f"]);

    expect(diff.hunks).toEqual([
      { baseStart: 1, baseEnd: 2, sideStart: 1, sideEnd: 2 },
      { baseStart: 5, baseEnd: 5, sideStart: 5, sideEnd: 6 },
    ]);
  });

  it("keeps scattered changes apart when there are more of them than the search limit", () => {
    const diff = diffLines(linesCalling("oldName", 10_000), linesCalling("newName", 10_000));

    expect(diff.hunks).toHaveLength(834);
    expect(diff.hunks.slice(0, 2)).toEqual([
      { baseStart: 0, baseEnd: 1, sideStart: 0, sideEnd: 1 },
      { baseStart: 12, baseEnd: 13, sideStart: 12, sideEnd: 13 },
    ]);
    expect(diff.hunks.at(-1)).toEqual({ baseStart: 9_996, baseEnd: 9_997, sideStart: 9_996, sideEnd: 9_997 });
  });

  it("gives up on large reorderings with one whole-range change", () => {
    const base = distinctLines("line", 10_000);
    const side = [...base].reverse();

    const diff = diffLines(base, side);

    expect(diff.hunks).toEqual([{ baseStart: 0, baseEnd: 10_000, sideStart: 0, sideEnd: 10_000 }]);
  });

  it("reports fully divergent large inputs as one whole-range change", () => {
    const base = distinctLines("base", 10_000);
    const side = distinctLines("side", 10_000);

    const diff = diffLines(base, side);

    expect(diff.hunks).toEqual([{ baseStart: 0, baseEnd: 10_000, sideStart: 0, sideEnd: 10_000 }]);
  });

  it("limits the whole-range change to the lines between the common start and end", () => {
    const prefix = distinctLines("prefix", 30);
    const suffix = distinctLines("suffix", 20);
    const middle = distinctLines("middle", 5_000);
    const base = [...prefix, ...middle, ...suffix];
    const side = [...prefix, ...middle.slice(0, 4_000).reverse(), ...suffix];

    const diff = diffLines(base, side);

    expect(diff.hunks).toEqual([{ baseStart: 30, baseEnd: 5_030, sideStart: 30, sideEnd: 4_030 }]);
    expect(diff.startPosition[29]).toBe(29);
    expect(diff.startPosition[30]).toBe(30);
    expect(diff.endPosition[5_029]).toBe(30);
    expect(diff.startPosition[5_030]).toBe(30);
    expect(diff.endPosition[5_030]).toBe(4_030);
    expect(diff.startPosition[5_031]).toBe(4_031);
    expect(diff.startPosition[5_050]).toBe(4_050);
  });
});
