import { describe, expect, it } from "vitest";
import { highlightRows } from "../render/html/changeHighlight";
import type { ResolutionKind, ResolutionRow } from "../model/resolutionView";

function cell(text: string | null) {
  return { text, lineNumber: text === null ? null : 0, spans: [] };
}

function row(kind: ResolutionKind, ours: string | null, result: string | null, theirs: string | null): ResolutionRow {
  return { ours: cell(ours), result: cell(result), theirs: cell(theirs), kind, isMarkerLine: false, checkbox: null, conflictIndex: null };
}

describe("highlightRows", () => {
  it("leaves rows all three sides agree on untinted", () => {
    expect(highlightRows([row("settled", "a", "a", "a")])).toEqual([{ ours: null, result: null, theirs: null }]);
  });

  it("marks every pane of an unresolved conflict as a conflict", () => {
    const [highlight] = highlightRows([row("unresolved", "x", "<<<<<<< HEAD", "y")]);

    expect(highlight).toEqual({ ours: "conflict", result: "conflict", theirs: "conflict" });
  });

  it("shows the side the working copy did not take as a modification", () => {
    const [highlight] = highlightRows([row("tookOurs", "mine", "mine", "theirs")]);

    expect(highlight).toEqual({ ours: null, result: "modified", theirs: "modified" });
  });

  it("calls lines only the side has an addition, for the whole block", () => {
    const highlights = highlightRows([row("tookOurs", "a", null, "x"), row("tookOurs", null, null, "y")]);

    expect(highlights.map((highlight) => highlight.theirs)).toEqual(["added", "added"]);
  });

  it("calls lines only the working copy has a deletion", () => {
    const [highlight] = highlightRows([row("tookTheirs", null, "kept", "kept")]);

    expect(highlight).toEqual({ ours: "deleted", result: "deleted", theirs: null });
  });

  it("tints a custom edit's result as modified when the sides disagree on the change type", () => {
    const [highlight] = highlightRows([row("custom", null, "edited", "other")]);

    expect(highlight).toEqual({ ours: "deleted", result: "modified", theirs: "modified" });
  });
});
