import { describe, expect, it } from "vitest";
import { renderGrid } from "../view/rowRenderer";
import { buildMergeView } from "../view/viewModel";

const options = { wordLevelHighlighting: true };

const document = [
  "<<<<<<< HEAD",
  "const x = <b>1</b>;",
  "||||||| base",
  "const x = 0;",
  "=======",
  "const x = 2;",
  ">>>>>>> feature",
].join("\n");

describe("renderGrid", () => {
  it("escapes markup coming from the file", () => {
    const html = renderGrid(buildMergeView(document, options));

    expect(html).toContain("&lt;b&gt;1&lt;/b&gt;");
    expect(html).not.toContain("<b>1</b>");
  });

  it("emits an action bar per conflict", () => {
    const html = renderGrid(buildMergeView(document, options));

    expect(html.match(/class="action-bar"/g)).toHaveLength(1);
    expect(html).toContain('data-resolution="localThenRemote"');
  });

  it("omits the base button when the file had 2-way markers", () => {
    const twoWay = ["<<<<<<< HEAD", "mine", "=======", "theirs", ">>>>>>> feature"].join("\n");

    const html = renderGrid(buildMergeView(twoWay, options));

    expect(html).not.toContain('data-resolution="base"');
  });

  it("wraps changed words in a highlight span", () => {
    const html = renderGrid(buildMergeView(document, options));

    expect(html).toContain('<span class="word">');
  });
});
