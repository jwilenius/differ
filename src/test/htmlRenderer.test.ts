import { describe, expect, it } from "vitest";
import { HtmlMergeRenderer } from "../render/html/htmlRenderer";
import { buildResolutionView } from "../model/resolutionView";
import { HunkSelection } from "../model/hunkSelection";
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

    const order = ["Changes from <b>feature</b>", "pane-result\">Result<", "Changes from <b>trunk</b>"];
    const positions = order.map((needle) => html.indexOf(needle));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("offers to take either side by branch name", () => {
    const html = renderer.render(model, context);

    expect(html).toContain("Accept feature");
    expect(html).toContain("Accept trunk");
    expect(html).toContain('data-resolution="base"');
  });

  it("puts accept arrows in the side gutters that face the working copy", () => {
    const html = renderer.render(model, context);

    expect(html).toMatch(/<div class="num pane-ours[^"]*"><button class="resolve gutter-action"[^>]*data-resolution="local"[^>]*>»</);
    expect(html).toMatch(/<div class="num pane-theirs[^"]*">\d+<button class="resolve gutter-action"[^>]*data-resolution="remote"[^>]*>«</);
  });

  it("tints an unresolved conflict with the conflict colour in all three panes", () => {
    const html = renderer.render(model, context);

    for (const pane of ["ours", "result", "theirs"]) {
      expect(html).toContain(`cell pane-${pane} chg-conflict`);
    }
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

const splittable: MergeSources = {
  ours: "a\nmine-1\nshared\nmine-2\nz",
  theirs: "a\ntheirs-1\nshared\ntheirs-2\nz",
  base: "a\nz",
  result: [
    "a",
    "<<<<<<< HEAD",
    "mine-1",
    "shared",
    "mine-2",
    "=======",
    "theirs-1",
    "shared",
    "theirs-2",
    ">>>>>>> trunk",
    "z",
  ].join("\n"),
  ourLabel: "feature",
  theirLabel: "trunk",
  isSidesSwapped: false,
};

describe("HtmlMergeRenderer hunk checkboxes", () => {
  const splitModel = buildResolutionView(splittable, { wordLevelHighlighting: false });
  const html = renderer.render(splitModel, context);

  it("puts a control beside each side of each divided piece", () => {
    const boxes = [...html.matchAll(/data-hunk="(\d+)" data-side="(\w+)"/g)]
      .map(([, hunk, side]) => `${hunk}:${side}`);

    expect(boxes).toEqual(["0:ours", "2:ours", "0:theirs", "2:theirs"]);
  });

  it("offers no control beside the lines both sides agree on", () => {
    const selection = new HunkSelection();
    selection.toggle(0, 1, "ours");

    // Hunk 1 is the agreed run, so ticking it changes nothing that is rendered.
    const html = renderer.render(
      buildResolutionView(splittable, { wordLevelHighlighting: false }, selection),
      context,
    );

    expect(html).not.toContain('data-hunk="1"');
  });

  it("shows what applying the current selection would commit", () => {
    expect(html).toContain("Apply selection (1 line)");

    const selection = new HunkSelection();
    selection.toggle(0, 0, "ours");
    selection.toggle(0, 2, "theirs");
    const picked = renderer.render(
      buildResolutionView(splittable, { wordLevelHighlighting: false }, selection),
      context,
    );

    expect(picked).toContain("Apply selection (3 lines)");
  });

  it("marks a ticked control as checked", () => {
    const selection = new HunkSelection();
    selection.toggle(0, 0, "ours");
    const picked = renderer.render(
      buildResolutionView(splittable, { wordLevelHighlighting: false }, selection),
      context,
    );

    expect(picked).toMatch(/aria-checked="true"[^>]*data-conflict="0" data-hunk="0" data-side="ours"/);
    expect(picked.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it("says how many parts a conflict divides into", () => {
    expect(html).toContain("2 parts");
  });
});

describe("HtmlMergeRenderer conflict ownership", () => {
  const adjacent: MergeSources = {
    ours: "a\nA1\nB1\nz",
    theirs: "a\nA2\nB2\nz",
    base: "a\nz",
    result: [
      "a",
      "<<<<<<< HEAD", "A1", "=======", "A2", ">>>>>>> trunk",
      "<<<<<<< HEAD", "B1", "=======", "B2", ">>>>>>> trunk",
      "z",
    ].join("\n"),
    ourLabel: "feature",
    theirLabel: "trunk",
    isSidesSwapped: false,
  };
  const html = renderer.render(buildResolutionView(adjacent, { wordLevelHighlighting: false }), context);

  it("gives each row of back-to-back conflicts to the conflict it lies in", () => {
    const owners = [...html.matchAll(/<div class="row[^"]*" data-row="\d+" data-conflict="(\d+)"><div class="cell pane-ours[^>]*>[^]*?<div class="cell pane-result[^>]*><span class="code">([^<]*)</g)]
      .map(([, conflict, text]) => `${conflict}:${text}`);

    expect(owners).toContain("0:A1");
    expect(owners).toContain("1:B1");
    expect(owners).toContain("1:&gt;&gt;&gt;&gt;&gt;&gt;&gt; trunk");
  });

  it("starts each conflict on its own row", () => {
    expect(html.match(/conflict-start/g)).toHaveLength(2);
  });
});
