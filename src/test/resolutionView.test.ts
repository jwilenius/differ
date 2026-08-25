import { describe, expect, it } from "vitest";
import { buildResolutionView } from "../model/resolutionView";
import type { MergeSources } from "../git/gitMergeSources";

const options = { wordLevelHighlighting: true };

function sources(overrides: Partial<MergeSources>): MergeSources {
  return {
    ours: "",
    theirs: "",
    base: null,
    result: "",
    ourLabel: "feature",
    theirLabel: "trunk",
    isSidesSwapped: false,
    ...overrides,
  };
}

describe("buildResolutionView", () => {
  it("marks rows settled when all three agree", () => {
    const text = "a\nb\nc";
    const model = buildResolutionView(sources({ ours: text, theirs: text, result: text }), options);

    expect(model.rows.every((row) => row.kind === "settled")).toBe(true);
    expect(model.conflicts).toHaveLength(0);
  });

  it("marks a row tookOurs when the working copy matches the branch", () => {
    const model = buildResolutionView(
      sources({ ours: "a\nMINE\nc", theirs: "a\nTHEIRS\nc", result: "a\nMINE\nc" }),
      options,
    );

    expect(model.rows[1].kind).toBe("tookOurs");
  });

  it("marks a row tookTheirs when the working copy matches the incoming side", () => {
    const model = buildResolutionView(
      sources({ ours: "a\nMINE\nc", theirs: "a\nTHEIRS\nc", result: "a\nTHEIRS\nc" }),
      options,
    );

    expect(model.rows[1].kind).toBe("tookTheirs");
  });

  it("marks a hand-edited row as custom", () => {
    const model = buildResolutionView(
      sources({ ours: "a\nMINE\nc", theirs: "a\nTHEIRS\nc", result: "a\nNEITHER\nc" }),
      options,
    );

    expect(model.rows[1].kind).toBe("custom");
  });

  it("marks every row of a marker region unresolved", () => {
    const result = ["a", "<<<<<<< HEAD", "MINE", "=======", "THEIRS", ">>>>>>> trunk", "c"].join("\n");
    const model = buildResolutionView(
      sources({ ours: "a\nMINE\nc", theirs: "a\nTHEIRS\nc", result }),
      options,
    );

    const unresolved = model.rows.filter((row) => row.kind === "unresolved");
    expect(unresolved.length).toBeGreaterThanOrEqual(5);
    expect(model.rows[0].kind).toBe("settled");
  });

  it("flags the git marker lines themselves", () => {
    const result = ["<<<<<<< HEAD", "MINE", "=======", "THEIRS", ">>>>>>> trunk"].join("\n");
    const model = buildResolutionView(sources({ ours: "MINE", theirs: "THEIRS", result }), options);

    const markers = model.rows.filter((row) => row.isMarkerLine).map((row) => row.result.text);
    expect(markers).toEqual(["<<<<<<< HEAD", "=======", ">>>>>>> trunk"]);
  });

  it("reports one action bar per unresolved conflict", () => {
    const result = [
      "<<<<<<< HEAD", "A", "=======", "B", ">>>>>>> trunk",
      "mid",
      "<<<<<<< HEAD", "C", "=======", "D", ">>>>>>> trunk",
    ].join("\n");
    const model = buildResolutionView(sources({ ours: "A\nmid\nC", theirs: "B\nmid\nD", result }), options);

    expect(model.conflicts.map((conflict) => conflict.index)).toEqual([0, 1]);
  });

  it("carries the branch labels and replay warning through", () => {
    const model = buildResolutionView(sources({ isSidesSwapped: true }), options);

    expect(model.ourLabel).toBe("feature");
    expect(model.theirLabel).toBe("trunk");
    expect(model.isSidesSwapped).toBe(true);
  });
});
