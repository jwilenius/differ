import { describe, expect, it } from "vitest";
import { alignThreeWay } from "../core/threeWayAligner";
import type { AlignedView } from "../core/types";

const kindsOf = (view: AlignedView): string[] => view.blocks.map((block) => block.kind);

describe("alignThreeWay", () => {
  it("reports no blocks when all three sides agree", () => {
    const lines = ["a", "b", "c"];

    const view = alignThreeWay(lines, lines, lines);

    expect(view.blocks).toHaveLength(0);
    expect(view.rows).toHaveLength(3);
    expect(view.rows.every((row) => row.kind === "unchanged")).toBe(true);
  });

  it("classifies a change made only on the local side", () => {
    const view = alignThreeWay(["a", "X", "c"], ["a", "b", "c"], ["a", "b", "c"]);

    expect(kindsOf(view)).toEqual(["localChange"]);
  });

  it("classifies a change made only on the remote side", () => {
    const view = alignThreeWay(["a", "b", "c"], ["a", "b", "c"], ["a", "X", "c"]);

    expect(kindsOf(view)).toEqual(["remoteChange"]);
  });

  it("classifies an identical change on both sides as bothSame", () => {
    const view = alignThreeWay(["a", "X", "c"], ["a", "b", "c"], ["a", "X", "c"]);

    expect(kindsOf(view)).toEqual(["bothSame"]);
  });

  it("classifies differing changes to the same line as a conflict", () => {
    const view = alignThreeWay(["a", "X", "c"], ["a", "b", "c"], ["a", "Y", "c"]);

    expect(kindsOf(view)).toEqual(["conflict"]);
  });

  it("keeps independent changes in separate blocks", () => {
    const view = alignThreeWay(["X", "b", "c"], ["a", "b", "c"], ["a", "b", "Y"]);

    expect(kindsOf(view)).toEqual(["localChange", "remoteChange"]);
  });

  it("pads shorter panes with filler cells so rows stay aligned", () => {
    const view = alignThreeWay(["a", "x", "y", "c"], ["a", "c"], ["a", "c"]);

    const fillerRows = view.rows.filter((row) => row.base.text === null);
    expect(fillerRows).toHaveLength(2);
    expect(fillerRows.map((row) => row.local.text)).toEqual(["x", "y"]);
    expect(fillerRows.every((row) => row.remote.text === null)).toBe(true);
  });

  it("gives every pane the same number of rows", () => {
    const view = alignThreeWay(["a", "x", "y"], ["a", "b"], ["a", "b", "c", "d"]);

    expect(view.rows.length).toBeGreaterThan(0);
    for (const block of view.blocks) {
      expect(block.rowEnd).toBeGreaterThan(block.rowStart);
    }
  });

  it("numbers lines per pane rather than per row", () => {
    const view = alignThreeWay(["a", "x", "b"], ["a", "b"], ["a", "b"]);

    const lastRow = view.rows[view.rows.length - 1];
    expect(lastRow.local.lineNumber).toBe(2);
    expect(lastRow.base.lineNumber).toBe(1);
  });

  it("highlights only the words that changed", () => {
    const view = alignThreeWay(["hello brave world"], ["hello cruel world"], ["hello cruel world"]);

    const changedRow = view.rows[0];
    expect(changedRow.local.spans).toHaveLength(1);
    const span = changedRow.local.spans[0];
    expect("hello brave world".slice(span.start, span.end)).toBe("brave");
  });

  it("omits word spans when highlighting is disabled", () => {
    const view = alignThreeWay(
      ["hello brave world"],
      ["hello cruel world"],
      ["hello cruel world"],
      { wordLevelHighlighting: false },
    );

    expect(view.rows[0].local.spans).toEqual([]);
  });

  it("falls back to comparing sides when there is no base", () => {
    const view = alignThreeWay(["mine here"], [], ["theirs here"]);

    expect(view.rows[0].local.spans.length).toBeGreaterThan(0);
  });
});
