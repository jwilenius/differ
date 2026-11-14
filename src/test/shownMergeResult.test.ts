import { describe, expect, it } from "vitest";
import { ShownMergeResult } from "../host/vscode/shownMergeResult";
import type { TokenStyle } from "../model/syntaxTokens";
import type { LineMarkup } from "../render/html/mergeViewRenderer";

const PLAIN: readonly TokenStyle[] = [{ color: null, fontStyle: 0 }];
const COLOURED: readonly TokenStyle[] = [...PLAIN, { color: "#ff0000", fontStyle: 0 }];

/** Markup for each text, `<b>` around the ones listed as coloured. */
function markup(texts: readonly string[], coloured: readonly string[] = []): LineMarkup[] {
  return texts.map((text) => ({ text, html: coloured.includes(text) ? `<b>${text}</b>` : text }));
}

describe("ShownMergeResult", () => {
  it("sends only the lines whose markup changed", () => {
    const shown = new ShownMergeResult(markup(["a", "b", "c"]), PLAIN);

    const changed = shown.update(markup(["a", "b", "c"], ["b"]), COLOURED);

    expect(changed).toEqual([{ line: 1, text: "b", html: "<b>b</b>" }]);
    expect(shown.styles).toBe(COLOURED);
  });

  it("sends nothing when highlighting again changes no markup", () => {
    const shown = new ShownMergeResult(markup(["a", "b"], ["b"]), COLOURED);
    shown.update(markup(["a", "b"]), PLAIN);

    expect(shown.update(markup(["a", "b"]), PLAIN)).toEqual([]);
  });

  it("sends a line the page edited even when its markup is unchanged", () => {
    const shown = new ShownMergeResult(markup(["a", "b"]), PLAIN);

    shown.noteEdit({ type: "editLine", line: 1, text: "b" });

    expect(shown.update(markup(["a", "b"]), PLAIN)).toEqual([{ line: 1, text: "b", html: "b" }]);
  });

  it("moves the lines after one the page split", () => {
    const shown = new ShownMergeResult(markup(["a", "b", "c"]), PLAIN);

    shown.noteEdit({ type: "splitLine", line: 0, offset: 0, seq: 1 });

    expect(shown.update(markup(["", "a", "b", "c"]), PLAIN).map(({ line }) => line)).toEqual([0, 1]);
  });

  it("moves the lines after two the page joined", () => {
    const shown = new ShownMergeResult(markup(["a", "b", "c"]), PLAIN);

    shown.noteEdit({ type: "joinWithPrevious", line: 1, seq: 1 });

    expect(shown.update(markup(["ab", "c"]), PLAIN).map(({ line }) => line)).toEqual([0]);
  });

  it("marks every line pasted over a range as drawn by the page", () => {
    const shown = new ShownMergeResult(markup(["a", "b", "c", "d"]), PLAIN);

    shown.noteEdit({ type: "replaceLines", line: 1, count: 2, lines: ["x", "y", "z"], seq: 1 });

    expect(shown.update(markup(["a", "x", "y", "z", "d"]), PLAIN).map(({ line }) => line)).toEqual([1, 2, 3]);
  });

  it("keeps the seq of the latest numbered edit, which a typed line does not change", () => {
    const shown = new ShownMergeResult(markup(["a", "b"]), PLAIN);

    shown.noteEdit({ type: "splitLine", line: 0, offset: 1, seq: 4 });
    shown.noteEdit({ type: "editLine", line: 0, text: "x" });

    expect(shown.seq).toBe(4);
  });
});
