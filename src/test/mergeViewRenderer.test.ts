import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { acceptSide, applySide, startMerge, tallyMerge, type MergeState } from "../model/mergeSession";
import { describeMerge } from "../model/mergeView";
import type { HighlightedText } from "../model/syntaxTokens";
import { HtmlMergeViewRenderer, resultLineMarkup, type MergeClientData, type MergeViewRenderContext } from "../render/html/mergeViewRenderer";

const CLIENT_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "media", "merge.js"), "utf8");

const CONTEXT: MergeViewRenderContext = {
  nonce: "abcdefghijklmnop0123",
  cspSource: "https://res",
  title: "Merge: a.ts",
  styleUris: ["https://res/diff.css", "https://res/merge.css"],
  scriptUris: ["https://res/diffGeometry.js", "https://res/mergeLines.js", "https://res/overviewRuler.js", "https://res/merge.js"],
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
    expect(html).toMatch(/data-accept="left"[^>]*>Accept Left</);
    expect(html).toMatch(/id="apply"[^>]*>Apply<\/button>/);
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

  it("ends the grid with the overview ruler beside the right pane, under a blank header", () => {
    const html = render(startMerge(BASE, LEFT, RIGHT));

    expect(html.match(/<div class="strip-header"><\/div>/g)).toHaveLength(3);
    expect(html).toMatch(/<div class="overview" id="overview" aria-hidden="true" title="[^"]+"><\/div>\n<\/main>/);
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
    expect(html).toMatch(/data-non-conflicting="all" title="Nothing to apply: no non-conflicting change is pending" disabled>/);
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

  describe("tooltips", () => {
    /** The value of attribute `name` on the first element whose opening tag matches `tag`, unescaped. */
    function attributeOf(html: string, tag: RegExp, name: string): string | undefined {
      const element = [...html.matchAll(/<[a-z]+\b[^>]*>/g)].map((match) => match[0]).find((opening) => tag.test(opening));
      const value = element && new RegExp(` ${name}="([^"]*)"`).exec(element)?.[1];
      return value?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    }

    it("names the side and the change or conflict on every chunk button", () => {
      const html = render(startMerge(BASE, LEFT, RIGHT));
      const button = (chunk: number, side: string, action: string): RegExp =>
        new RegExp(`data-chunk="${chunk}" data-side="${side}" data-action="${action}"`);

      expect(attributeOf(html, button(1, "left", "apply"), "title")).toBe("Accept left change 1: apply it to the result");
      expect(attributeOf(html, button(1, "left", "apply"), "aria-label")).toBe("Accept left change 1");
      expect(attributeOf(html, button(1, "left", "ignore"), "title")).toBe("Ignore left change 1: leave the result as it is");
      expect(attributeOf(html, button(1, "left", "ignore"), "aria-label")).toBe("Ignore left change 1");
      expect(attributeOf(html, button(2, "right", "apply"), "aria-label")).toBe("Accept right change 2");
      expect(attributeOf(html, button(0, "right", "apply"), "title")).toBe("Accept the right side of conflict 1: apply it to the result");
      expect(attributeOf(html, button(0, "left", "ignore"), "aria-label")).toBe("Ignore the left side of conflict 1");
    });

    it("keeps a change's number once an earlier change is resolved", () => {
      const html = render(applySide(startMerge(BASE, LEFT, RIGHT), 1, "left"));

      expect(attributeOf(html, /data-chunk="2" data-side="right" data-action="apply"/, "aria-label")).toBe("Accept right change 2");
    });

    it("explains the status counts, and says when nothing is left", () => {
      const pending = render(startMerge(BASE, LEFT, RIGHT));
      const done = render(acceptSide(startMerge(BASE, LEFT, RIGHT), "left"));

      expect(attributeOf(pending, /class="status"/, "title")).toBe(
        "Still to resolve: 2 changes, blocks only one side changed or both changed alike, and 1 conflict, blocks both sides changed differently",
      );
      expect(attributeOf(done, /class="status"/, "title")).toBe("Every change and conflict has been applied or ignored");
    });

    it("names a block both sides changed alike a change, not a conflict", () => {
      const html = render(startMerge("a\nb\nc", "a\nB\nc", "a\nB\nc"));

      expect(html).toContain("1 change. 0 conflicts.");
      expect(attributeOf(html, /data-side="left" data-action="apply"/, "aria-label")).toBe("Accept left change 1");
    });

    it("explains the non-conflicting label and buttons", () => {
      const html = render(startMerge(BASE, LEFT, RIGHT));

      expect(attributeOf(html, /class="label"/, "title")).toBe(
        "Apply every pending change that does not conflict, from the left side, the right side or both",
      );
      expect(attributeOf(html, /data-non-conflicting="left"/, "title")).toBe("Apply non-conflicting changes from the left side");
    });

    it("marks each side read-only and names its label, and shows the result's full path", () => {
      const html = render(startMerge(BASE, LEFT, RIGHT), { resultPath: "src/deeply/nested/a.ts" });

      expect(attributeOf(html, /class="pane-header pane-left"/, "title")).toBe(
        "The left side, read-only: changes from main. » in its gutter applies a change to the result, × ignores it",
      );
      expect(attributeOf(html, /class="pane-header pane-right"/, "title")).toBe(
        "The right side, read-only: changes from feature/<sku>. « in its gutter applies a change to the result, × ignores it",
      );
      expect(attributeOf(html, /class="lock"/, "aria-label")).toBe("Read-only");
      expect(attributeOf(html, /class="lock"/, "title")).toBe("Read-only: only the result can be edited");
      expect(attributeOf(html, /class="pane-header pane-result"/, "title")).toBe(
        "The result, editable: src/deeply/nested/a.ts\nApply writes it to this file",
      );
    });

    it("escapes the result's path in its tooltip", () => {
      const html = render(startMerge(BASE, LEFT, RIGHT), { resultPath: 'a"<b>&.ts' });

      expect(html).toContain('title="The result, editable: a&quot;&lt;b&gt;&amp;.ts\nApply writes it to this file"');
    });

    it("says what each footer button does, and whether Apply stages the file", () => {
      const pending = render(startMerge(BASE, LEFT, RIGHT));
      const done = render(acceptSide(startMerge(BASE, LEFT, RIGHT), "left"));

      expect(attributeOf(pending, /data-accept="left"/, "title")).toBe(
        "Replace the whole result with the left side (main), discarding edits and resolving every change",
      );
      expect(attributeOf(pending, /data-accept="right"/, "title")).toBe(
        "Replace the whole result with the right side (feature/<sku>), discarding edits and resolving every change",
      );
      expect(attributeOf(pending, /id="cancel"/, "title")).toBe("Close without writing the file; asks first when the merge view has changes");
      expect(attributeOf(pending, /id="apply"/, "title")).toBe(
        "Write the result to the file and save it, then close; asks first while changes are unresolved, and does not stage the file",
      );
      expect(attributeOf(done, /id="apply"/, "title")).toBe("Write the result to the file, save it and stage it (git add), then close");
    });

    it("numbers every line in its tooltip", () => {
      const html = render(startMerge(BASE, LEFT, RIGHT));

      for (const pane of ["left", "result", "right"]) {
        expect(paneLines(html, pane)[2]).toContain('<span class="num" title="Line 3">3</span>');
      }
    });

    it("gives every button a tooltip", () => {
      const html = render(startMerge(BASE, LEFT, RIGHT));
      const untitled = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]).filter((tag) => !/ title="[^"]+"/.test(tag));

      expect(untitled).toEqual([]);
    });
  });
});
