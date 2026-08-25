import { describe, expect, it } from "vitest";
import { HtmlMergeRenderer } from "../render/html/htmlRenderer";
import { buildResolutionView } from "../model/resolutionView";
import type { MergeSources } from "../git/gitMergeSources";

const assets = { styleUri: "res://main.css", scriptUri: "res://main.js", cspSource: "res:" };
const context = { fileName: "f.txt", showResultPane: true, focus: null };
const renderer = new HtmlMergeRenderer(assets);

const conflicted: MergeSources = {
  ours: "a\nMINE\nc",
  theirs: "a\nTHEIRS\nc",
  base: "a\nshared\nc",
  result: ["a", "<<<<<<< HEAD", "MINE", "||||||| x", "shared", "=======", "THEIRS", ">>>>>>> trunk", "c"].join("\n"),
  ourLabel: "feature",
  theirLabel: "trunk",
  isSidesSwapped: false,
};

const model = buildResolutionView(conflicted, { wordLevelHighlighting: true });

describe("HtmlMergeRenderer", () => {
  it("names the panes after the branches, with the result in the middle", () => {
    const html = renderer.render(model, context);

    const order = ["pane-ours\">feature<", "pane-result\">Will be committed<", "pane-theirs\">trunk<"];
    const positions = order.map((needle) => html.indexOf(needle));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("offers to take either side by branch name", () => {
    const html = renderer.render(model, context);

    expect(html).toContain("Take feature");
    expect(html).toContain("Take trunk");
    expect(html).toContain('data-resolution="base"');
  });

  it("locks the script to a fresh nonce each render", () => {
    const first = renderer.render(model, context).match(/nonce-([A-Za-z0-9]{32})/)?.[1];
    const second = renderer.render(model, context).match(/nonce-([A-Za-z0-9]{32})/)?.[1];

    expect(first).toBeDefined();
    expect(first).not.toBe(second);
  });

  it("escapes file content", () => {
    const withMarkup = { ...conflicted, result: "<img src=x onerror=alert(1)>" };
    const html = renderer.render(
      buildResolutionView(withMarkup, { wordLevelHighlighting: true }),
      context,
    );

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("warns when a rebase has reversed the sides", () => {
    const swapped = buildResolutionView({ ...conflicted, isSidesSwapped: true }, { wordLevelHighlighting: true });

    expect(renderer.render(swapped, context)).toContain("sides are reversed");
    expect(renderer.render(model, context)).not.toContain("sides are reversed");
  });

  it("reports a clean file as ready to commit", () => {
    const clean = buildResolutionView(
      { ...conflicted, result: "a\nMINE\nc" },
      { wordLevelHighlighting: true },
    );

    expect(renderer.render(clean, context)).toContain("Ready to commit");
  });

  it("makes only the working-copy pane editable", () => {
    const html = renderer.render(model, context);

    const editable = [...html.matchAll(/<div class="cell pane-(\w+)[^"]*"[^>]*contenteditable/g)];
    expect(editable.length).toBeGreaterThan(0);
    expect(new Set(editable.map((match) => match[1]))).toEqual(new Set(["result"]));
  });

  it("leaves the branch and incoming panes read-only", () => {
    const html = renderer.render(model, context);

    expect(html).not.toMatch(/pane-ours[^>]*contenteditable/);
    expect(html).not.toMatch(/pane-theirs[^>]*contenteditable/);
  });

  it("does not let the conflict markers themselves be typed over", () => {
    const html = renderer.render(model, context);

    const markerCells = [...html.matchAll(/marker-line.*?<div class="cell pane-result[^>]*>/g)];
    expect(markerCells.length).toBeGreaterThan(0);
    expect(markerCells.every((match) => !match[0].includes("contenteditable"))).toBe(true);
  });

  it("restores the caret after an edit rebuilt the view", () => {
    const html = renderer.render(model, { ...context, focus: { line: 4, offset: 3 } });

    expect(html).toContain('data-focus-line="4"');
    expect(html).toContain('data-focus-offset="3"');
  });

  it("omits focus attributes when nothing needs restoring", () => {
    expect(renderer.render(model, context)).not.toContain("data-focus-line");
  });

  it("collapses to two panes when the result pane is hidden", () => {
    expect(renderer.render(model, { ...context, showResultPane: false })).toContain('<body class="hide-result">');
  });
});
