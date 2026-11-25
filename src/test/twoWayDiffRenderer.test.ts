import { describe, expect, it } from "vitest";
import type { HighlightedText } from "../model/syntaxTokens";
import { FontStyleFlag } from "../model/syntaxTokens";
import { buildTwoWayDiff } from "../model/twoWayDiff";
import type { TwoWayDiffRenderContext } from "../render/html/twoWayDiffRenderer";
import { HtmlTwoWayDiffRenderer } from "../render/html/twoWayDiffRenderer";

const NONCE = "abcdefghijklmnop0123";

const CONTEXT: TwoWayDiffRenderContext = {
  assets: { styleUri: "https://res/diff.css", scriptUri: "https://res/diff.js", cspSource: "https://res" },
  geometryScriptUri: "https://res/diffGeometry.js",
  nonce: NONCE,
  cspSource: "https://res",
  baseLabel: "1807da6c",
  resultLabel: "2 selected commits",
  basePath: "src/a.ts",
  resultPath: "src/a.ts",
  title: "a.ts (1807da6c ↔ 2 selected commits)",
  page: 4,
};

function unstyled(text: string): HighlightedText {
  return {
    styles: [{ color: null, fontStyle: 0 }],
    lines: text.split("\n").map((line) => [{ length: line.length, styleIndex: 0 }]),
  };
}

function render(
  baseText: string,
  resultText: string,
  overrides: Partial<TwoWayDiffRenderContext> = {},
  highlights: { base?: HighlightedText; result?: HighlightedText } = {},
): string {
  return new HtmlTwoWayDiffRenderer().render(
    {
      diff: buildTwoWayDiff(baseText, resultText, { wordLevel: true }),
      baseText,
      resultText,
      baseHighlight: highlights.base ?? unstyled(baseText),
      resultHighlight: highlights.result ?? unstyled(resultText),
    },
    { ...CONTEXT, ...overrides },
  );
}

interface RenderedLine {
  readonly classes: string;
  readonly markup: string;
}

/** The pane's `index`th line (0-based): its class list and inner markup. */
function lineOf(html: string, side: "base" | "result", index: number): RenderedLine {
  const pane = html.split(`id="scroll-${side}"`)[1].split(`id="scroll-result"`)[0];
  const lines = [...pane.matchAll(/<div class="(line(?: [^"]*)?)">(.*?)<\/div>/g)];
  return { classes: lines[index][1], markup: lines[index][2] };
}

function clientData(html: string): unknown {
  const encoded = /data-diff="([^"]*)"/.exec(html)![1];
  return JSON.parse(encoded.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

describe("HtmlTwoWayDiffRenderer", () => {
  it("restricts the page with a nonce-based content security policy", () => {
    const html = render("a", "b");

    expect(html).toContain(
      `content="default-src 'none'; style-src https://res 'nonce-${NONCE}'; script-src 'nonce-${NONCE}'"`,
    );
    expect(html).toContain(`<style nonce="${NONCE}">`);
    expect(html).toContain(`<script nonce="${NONCE}" src="https://res/diffGeometry.js"></script>\n<script nonce="${NONCE}" src="https://res/diff.js"></script>`);
    expect(html).toContain(`<link href="https://res/diff.css" rel="stylesheet">`);
  });

  it("rejects a weak nonce", () => {
    expect(() => render("a", "b", { nonce: "short" })).toThrow(/nonce/);
  });

  it("escapes hostile file text, labels, paths and title", () => {
    const hostile = `<img src=x onerror="alert(1)">&`;
    const html = render(`${hostile}\nsame`, `x\nsame`, {
      baseLabel: hostile,
      resultLabel: hostile,
      basePath: hostile,
      resultPath: hostile,
      title: hostile,
    });

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
  });

  it("puts each pane's own lines and line numbers in order, gutter facing the strip, numbers out of Ctrl+F's text", () => {
    const html = render("one\ntwo", "one\ntwo\nthree");

    expect(lineOf(html, "base", 1).markup).toBe(`<span class="code"><span class="tk-base-0">two</span></span><span class="num" data-number="2" title="Line 2"></span>`);
    expect(lineOf(html, "result", 2).markup).toMatch(/^<span class="num" data-number="3" title="[^"]*"><\/span><span class="code">/);
    expect(html.split(`id="scroll-base"`)[1].split(`id="scroll-result"`)[0].match(/class="line[ "]/g)).toHaveLength(2);
  });

  it("tints changed lines by block kind and marks empty ranges with a thin-line class", () => {
    const html = render("a\nold\nb\ngone\nc", "a\nnew\nb\nc\nadded");

    expect(lineOf(html, "base", 1).classes).toBe("line chg-modified");
    expect(lineOf(html, "base", 3).classes).toBe("line chg-deleted");
    expect(lineOf(html, "result", 3).classes).toBe("line gap-before gap-deleted");
    expect(lineOf(html, "base", 4).classes).toBe("line gap-after gap-added");
    expect(lineOf(html, "result", 4).classes).toBe("line chg-added");
    expect(lineOf(html, "base", 0).classes).toBe("line");
  });

  it("publishes the blocks and line counts the client script needs", () => {
    const html = render("a\nold\nb", "a\nnew\nb\nc");

    expect(clientData(html)).toEqual({
      blocks: [
        { kind: "modified", base: [1, 2], result: [1, 2] },
        { kind: "added", base: [3, 3], result: [3, 4] },
      ],
      baseLineCount: 3,
      resultLineCount: 4,
    });
    expect(html).toContain(`<svg id="connectors"`);
    expect(html).toMatch(/id="prev"[\s\S]*id="next"[\s\S]*id="open-native"/);
  });

  it("stamps the page with its number, which the client sends back with every message", () => {
    expect(render("a", "b")).toContain(`<main class="diff" id="diff" data-page="4" data-diff=`);
  });

  it("numbers the change the view opens at in a polite live status", () => {
    const status = (html: string) => /<span id="status" class="status"[^>]*>(.*?)<\/span>\n/.exec(html)![1];

    expect(render("a\nold\nb", "a\nnew\nb\nc")).toMatch(
      /<span id="status" class="status" role="status" aria-live="polite" title="[^"]*"><span id="current-number">1<\/span> \/ 2 differences<\/span>/,
    );
    expect(status(render("a\nold\nb", "a\nnew\nb\nc", { startAt: "last" })))
      .toBe(`<span id="current-number">2</span> / 2 differences`);
    expect(status(render("a", "b"))).toBe(`<span id="current-number">1</span> / 1 difference`);
  });

  it("splits tokens at word-span edges so tags nest", () => {
    const base = "let value = 1;";
    const result = "let value = 22;";
    // Tokens: "let " | "value = 22;" — the changed "22" sits inside the second token.
    const resultHighlight: HighlightedText = {
      styles: [{ color: "#569cd6", fontStyle: 0 }, { color: null, fontStyle: 0 }],
      lines: [[{ length: 4, styleIndex: 0 }, { length: 11, styleIndex: 1 }]],
    };
    const html = render(base, result, {}, { result: resultHighlight });

    expect(lineOf(html, "result", 0).markup).toContain(
      `<span class="tk-result-0">let </span><span class="tk-result-1">value = </span>`
        + `<span class="word"><span class="tk-result-1">22</span></span><span class="tk-result-1">;</span>`,
    );
  });

  it("keeps a word span that crosses tokens around whole token pieces", () => {
    const resultHighlight: HighlightedText = {
      styles: [{ color: "#111", fontStyle: 0 }, { color: "#222", fontStyle: 0 }],
      lines: [[{ length: 2, styleIndex: 0 }, { length: 2, styleIndex: 1 }]],
    };
    const html = render("x", "abcd", {}, { result: resultHighlight });

    expect(lineOf(html, "result", 0).markup).toContain(
      `<span class="word"><span class="tk-result-0">ab</span><span class="tk-result-1">cd</span></span>`,
    );
  });

  it("drops the carriage return of CRLF lines so each stays on one row", () => {
    const html = render("a\r\nb\r\n", "a\r\nb\r\n");

    expect(lineOf(html, "base", 0).markup).toBe(`<span class="code"><span class="tk-base-0">a</span></span><span class="num" data-number="1" title="Line 1"></span>`);
    expect(html).not.toContain("\r");
  });

  it("leaves text the tokens do not cover unstyled", () => {
    const html = render("same", "same", {}, { base: { styles: [], lines: [] } });

    expect(lineOf(html, "base", 0).markup).toContain(`<span class="code">same</span>`);
  });

  it("writes style rules only from valid colours and known font flags", () => {
    const baseHighlight: HighlightedText = {
      styles: [
        { color: "#abc", fontStyle: FontStyleFlag.italic | FontStyleFlag.bold },
        { color: "red;} body{display:none", fontStyle: FontStyleFlag.underline | FontStyleFlag.strikethrough },
        { color: "#11223344", fontStyle: 0 },
        { color: null, fontStyle: 0 },
      ],
      lines: [[{ length: 1, styleIndex: 0 }]],
    };
    const html = render("a", "a", {}, { base: baseHighlight });
    const styles = /<style nonce="[^"]*">([^<]*)<\/style>/.exec(html)![1];

    expect(styles).toContain(".tk-base-0{color:#abc;font-style:italic;font-weight:bold}");
    expect(styles).toContain(".tk-base-1{text-decoration:underline line-through}");
    expect(styles).toContain(".tk-base-2{color:#11223344}");
    expect(styles).not.toContain("tk-base-3");
    expect(styles).not.toContain("display:none");
  });

  it("says when there are no differences, with no change number", () => {
    const html = render("same", "same");

    expect(html).toContain(`<span id="status" class="status" role="status" aria-live="polite" title="The two sides have no line differences">No differences</span>`);
    expect(html).not.toContain("current-number");
  });

  it("publishes the neighbouring files and the change to start at when the diff belongs to a file list", () => {
    const html = render("a", "b", { fileList: { hasPrevious: false, hasNext: true }, startAt: "last" });

    expect(html).toContain(`data-files="{&quot;hasPrevious&quot;:false,&quot;hasNext&quot;:true}"`);
    expect(html).toContain(`data-start-at="last"`);
  });

  it("leaves out the file list and starts at the first change by default", () => {
    const html = render("a", "b");

    expect(html).not.toContain("data-files");
    expect(html).toContain(`data-start-at="first"`);
  });

  it("puts a hidden current-change marker after each pane's lines", () => {
    const html = render("a", "b");

    for (const side of ["base", "result"]) {
      expect(html).toContain(`<div class="current-change" id="current-${side}" hidden aria-hidden="true"></div></div></div>`);
    }
  });

  it("has a polite live region for the file-step hint", () => {
    expect(render("a", "b")).toContain(`<div id="file-step" class="file-step" role="status" aria-live="polite"></div>`);
  });

  describe("tooltips", () => {
    /** The `title` of the first element carrying `marker` in its opening tag. */
    function titleOf(html: string, marker: string): string {
      const tag = new RegExp(`<[^>]*${marker}[^>]*>`).exec(html)![0];
      return /title="([^"]*)"/.exec(tag)![1];
    }

    it("says which difference the status marks and how to move between them", () => {
      expect(titleOf(render("a\nold\nb", "a\nnew\nb\nc"), `id="status"`))
        .toBe("Difference 1 of 2 is marked; F7 / Shift+F7 or ↓/↑ go to the next / previous");
      expect(titleOf(render("a\nold\nb", "a\nnew\nb\nc", { startAt: "last" }), `id="status"`))
        .toBe("Difference 2 of 2 is marked; F7 / Shift+F7 or ↓/↑ go to the next / previous");
    });

    it("names each pane's side and label and shows its full path, which the header may cut short", () => {
      const html = render("a", "b", { resultPath: "src/deeply/nested/folder/a.ts" });

      expect(titleOf(html, `class="pane-header pane-base"`)).toBe("Left side: 1807da6c\nsrc/a.ts");
      expect(titleOf(html, `class="pane-header pane-result"`)).toBe("Right side: 2 selected commits\nsrc/deeply/nested/folder/a.ts");
    });

    it("escapes the labels and paths in the pane headers' tooltips", () => {
      const html = render("a", "b", { baseLabel: `"><b>`, basePath: `a"b` });

      expect(titleOf(html, `class="pane-header pane-base"`)).toBe("Left side: &quot;&gt;&lt;b&gt;\na&quot;b");
    });

    it("numbers each gutter line and names the difference a changed line is part of", () => {
      const html = render("a\nold\nb\ngone\nc", "a\nnew\nb\nc\nadded");
      const numberTitle = (side: "base" | "result", index: number) => /title="([^"]*)"/.exec(lineOf(html, side, index).markup)![1];

      expect(numberTitle("base", 0)).toBe("Line 1");
      expect(numberTitle("base", 1)).toBe("Line 2, in difference 1 of 3 (modified)");
      expect(numberTitle("base", 3)).toBe("Line 4, in difference 2 of 3 (deleted)");
      expect(numberTitle("result", 3)).toBe("Line 4");
      expect(numberTitle("result", 4)).toBe("Line 5, in difference 3 of 3 (added)");
    });

    it("offers an unchecked Wrap lines checkbox with a tooltip just before the status", () => {
      const html = render("a", "b");

      expect(html).toMatch(/<label class="wrap-toggle" title="[^"]+"><input type="checkbox" id="wrap-lines"> Wrap lines<\/label>\s*<span id="status"/);
      expect(titleOf(html, `class="wrap-toggle"`)).toBe("Wrap long lines to the pane width on both sides, keeping the sides aligned");
    });

    it("gives every toolbar button a tooltip", () => {
      const buttons = [...render("a", "b").matchAll(/<button[^>]*>/g)].map((match) => match[0]);

      expect(buttons).toHaveLength(3);
      expect(buttons.filter((button) => !/ title="[^"]+"/.test(button))).toEqual([]);
    });
  });
});
