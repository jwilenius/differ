import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { applySide, startMerge, tallyMerge, type MergeState } from "../model/mergeSession";
import { describeMerge } from "../model/mergeView";
import type { HighlightedText } from "../model/syntaxTokens";
import { HtmlMergeViewRenderer, resultLineMarkup, type MergeClientData, type MergeViewRenderContext } from "../render/html/mergeViewRenderer";

const CLIENT_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "media", "merge.js"), "utf8");

const CONTEXT: MergeViewRenderContext = {
  nonce: "abcdefghijklmnop0123",
  cspSource: "https://res",
  title: "Merge: a.ts",
  styleUris: ["https://res/diff.css", "https://res/merge.css"],
  scriptUris: ["https://res/diffGeometry.js", "https://res/mergeLines.js", "https://res/merge.js"],
  leftLabel: "main",
  rightLabel: "feature/<sku>",
  resultPath: "src/a.ts",
  isSidesSwapped: false,
  page: 1,
  caret: null,
};

// One conflict on line 1, a left-only change on line 3, a right-only addition at the end.
const BASE = "a\nb\nc\nd\ne\nf";
const LEFT = "a\nL\nc\nD\ne\nf";
const RIGHT = "a\nR\nc\nd\ne\nf\ng";

function unstyled(lines: readonly string[]): HighlightedText {
  return { styles: [{ color: null, fontStyle: 0 }], lines: lines.map((line) => [{ length: line.length, styleIndex: 0 }]) };
}

function render(state: MergeState, overrides: Partial<MergeViewRenderContext> = {}): string {
  return new HtmlMergeViewRenderer().render(
    {
      state,
      chunks: describeMerge(state, { wordLevel: true }),
      tally: tallyMerge(state),
      leftHighlight: unstyled(state.leftLines),
      rightHighlight: unstyled(state.rightLines),
      resultHighlight: unstyled(state.resultLines),
    },
    { ...CONTEXT, ...overrides },
  );
}

function clientData(html: string): MergeClientData {
  const encoded = /data-merge="([^"]*)"/.exec(html)?.[1] ?? "";
  return JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as MergeClientData;
}

/** The markup of each line of one pane, in order. */
function paneLines(html: string, pane: string): string[] {
  const start = html.indexOf(`id="scroll-${pane}"`);
  const end = html.indexOf("</div></div>", start);
  return html.slice(start, end).split(/<div class="line(?=[ "])/).slice(1);
}

describe("HtmlMergeViewRenderer", () => {
  it("shows IntelliJ's status, headers and footer", () => {
    const html = render(startMerge(BASE, LEFT, RIGHT));

    expect(html).toContain("2 changes. 1 conflict.");
    expect(html).toContain("Changes from <b>main</b>");
    expect(html).toContain("Changes from <b>feature/&lt;sku&gt;</b>");
    expect(html).toContain('<span class="path">src/a.ts</span>');
    expect(html).toMatch(/data-accept="left">Accept Left</);
    expect(html).toContain('id="apply">Apply</button>');
  });

  it("puts apply and ignore buttons on each pending side, pointing at the result", () => {
    const html = render(startMerge(BASE, LEFT, RIGHT));
    const left = paneLines(html, "left");
    const right = paneLines(html, "right");

    expect(left[1]).toMatch(/^ chg-conflict"/);
    expect(left[1]).toMatch(/data-action="ignore"[^>]*>×<\/button><button[^>]*data-action="apply"[^>]*>»/);
    expect(left[3]).toMatch(/^ chg-modified"/);
    expect(right[1]).toMatch(/data-action="apply"[^>]*>«<\/button><button[^>]*data-action="ignore"/);
    expect(right[6]).toMatch(/^ chg-added"/);
    expect(left[0]).not.toContain("button");
  });

  it("keeps the buttons of a gap before the last line and a gap ending the file on the same line", () => {
    const html = render(startMerge("a\nX\nb\nY", "a\nb", "a\nX\nb\nY"));
    const left = paneLines(html, "left");
    const leftChunks = [...html.matchAll(/data-chunk="(\d+)" data-side="left" data-action="apply"/g)].map((match) => match[1]);

    expect(clientData(html).chunks.map((chunk) => chunk.left)).toEqual([[1, 1], [2, 2]]);
    expect(leftChunks).toEqual(["0", "1"]);
    expect(left[1]).toContain('data-chunk="0"');
    expect(left[1]).toContain('data-chunk="1"');
  });

  it("widens every gutter of a pane holding two chunks' buttons on one line, so the gutter stays straight", () => {
    const shared = render(startMerge("a\nX\nb\nY", "a\nb", "a\nX\nb\nY"));
    const single = render(startMerge(BASE, LEFT, RIGHT));

    expect(shared).toContain('class="scroller pane-left double-acts" id="scroll-left"');
    expect(shared).toContain('class="scroller pane-right" id="scroll-right"');
    expect(single).not.toContain("double-acts");
  });

  it("draws an addition's empty range in the result as a gap after the last line", () => {
    const result = paneLines(render(startMerge(BASE, LEFT, RIGHT)), "result");

    expect(result).toHaveLength(6);
    expect(result[5]).toMatch(/^ gap-after gap-added"/);
    expect(result[1]).toContain('contenteditable="plaintext-only"');
  });

  it("stops highlighting a side once it is applied, and publishes the chunks to the client", () => {
    const state = applySide(startMerge(BASE, LEFT, RIGHT), 1, "left");
    const html = render(state);

    expect(paneLines(html, "left")[3]).toMatch(/^"/);
    expect(paneLines(html, "result")[3]).toMatch(/^"/);
    expect(clientData(html).chunks[1]).toEqual({
      tint: "modified",
      isResolved: true,
      isLeftPending: false,
      isRightPending: false,
      left: [3, 4],
      right: [3, 4],
      result: [3, 4],
    });
  });

  it("disables the non-conflicting actions when only conflicts remain", () => {
    const state = applySide(applySide(startMerge(BASE, LEFT, RIGHT), 1, "left"), 2, "right");
    const html = render(state);

    expect(html).toContain("0 changes. 1 conflict.");
    expect(html).toMatch(/data-non-conflicting="all"[^>]* disabled>/);
  });

  it("warns when the sides are swapped", () => {
    const html = render(startMerge(BASE, LEFT, RIGHT), { isSidesSwapped: true });

    expect(html).toContain("Sides are reversed");
  });

  it("gives the result's token styles their own stylesheet, which the client replaces", () => {
    const state = startMerge(BASE, LEFT, RIGHT);
    const keyword = { color: "#569cd6", fontStyle: 0 };
    const resultHighlight = { styles: [{ color: null, fontStyle: 0 }, keyword], lines: state.resultLines.map((line) => [{ length: line.length, styleIndex: 1 }]) };
    const html = new HtmlMergeViewRenderer().render(
      { state, chunks: describeMerge(state, { wordLevel: true }), tally: tallyMerge(state), leftHighlight: unstyled(state.leftLines), rightHighlight: unstyled(state.rightLines), resultHighlight },
      CONTEXT,
    );

    expect(html).toContain('<style nonce="abcdefghijklmnop0123" id="result-styles">.tk-result-1{color:#569cd6}</style>');
  });

  it("publishes the markup of every result line as it renders it", () => {
    const state = startMerge(BASE, LEFT, RIGHT);
    const chunks = describeMerge(state, { wordLevel: true });
    const html = render(state);

    const markup = resultLineMarkup({ state, chunks, resultHighlight: unstyled(state.resultLines) });

    expect(markup.map((line) => line.text)).toEqual(state.resultLines);
    expect(paneLines(html, "result").map((line) => /data-line="\d+">(.*)<\/span>(?:<\/div>)?$/.exec(line)?.[1])).toEqual(markup.map((line) => line.html));
  });

  it("numbers the page for the client's messages", () => {
    const html = render(startMerge(BASE, LEFT, RIGHT), { page: 7 });

    expect(html).toContain('id="merge" data-page="7"');
  });

  it("names where the client puts the caret after an undo or redo", () => {
    const html = render(startMerge(BASE, LEFT, RIGHT), { caret: { line: 3, column: 2 } });

    expect(html).toContain('id="merge" data-page="1" data-caret-line="3" data-caret-column="2"');
  });

  it("names no caret position when the host has none", () => {
    expect(render(startMerge(BASE, LEFT, RIGHT))).not.toContain("data-caret");
  });

  it("rejects a weak nonce", () => {
    expect(() => render(startMerge(BASE, LEFT, RIGHT), { nonce: "short" })).toThrow(/nonce/);
  });

  it("renders every element the client looks up", () => {
    const html = render(startMerge(BASE, LEFT, RIGHT));
    const ids = [...CLIENT_SOURCE.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);

    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
