import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { ignoreSide, joinWithPrevious, splitLine, startMerge, tallyMerge, type MergeState } from "../model/mergeSession";
import { describeMerge } from "../model/mergeView";
import type { HighlightedText } from "../model/syntaxTokens";
import { editedLines as editedLinesOnHost } from "../host/vscode/mergeMessages";
import { HtmlMergeViewRenderer, type MergeClientData } from "../render/html/mergeViewRenderer";

const LINES_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "media", "mergeLines.js"), "utf8");

/** The pure functions `mergeLines.js` defines at top level. */
interface MergeLines {
  resultLineClasses(chunks: MergeClientData["chunks"], lineCount: number): string[];
  pastedLines(before: string, text: string, after: string): string[];
  editedLines(message: Record<string, unknown>): { line: number; removed: number; added: number };
  lineAfterEdits(edits: readonly { line: number; removed: number; added: number }[], line: number): number | null;
}

function loadMergeLines(): MergeLines {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(LINES_SOURCE, context);
  return context as unknown as MergeLines;
}

function unstyled(lines: readonly string[]): HighlightedText {
  return { styles: [{ color: null, fontStyle: 0 }], lines: lines.map((line) => [{ length: line.length, styleIndex: 0 }]) };
}

function render(state: MergeState): string {
  const input = {
    state,
    chunks: describeMerge(state, { wordLevel: true }),
    tally: tallyMerge(state),
    leftHighlight: unstyled(state.leftLines),
    rightHighlight: unstyled(state.rightLines),
    resultHighlight: unstyled(state.resultLines),
  };
  return new HtmlMergeViewRenderer().render(input, {
    nonce: "abcdefghijklmnop0123",
    cspSource: "https://res",
    title: "Merge: a.ts",
    styleUris: [],
    scriptUris: [],
    leftLabel: "main",
    rightLabel: "feature",
    resultPath: "a.ts",
    isSidesSwapped: false,
    page: 1,
    caret: null,
  });
}

function clientData(html: string): MergeClientData {
  const encoded = /data-merge="([^"]*)"/.exec(html)?.[1] ?? "";
  return JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as MergeClientData;
}

/** The class attribute of every result line the host rendered. */
function renderedResultClasses(html: string): string[] {
  const start = html.indexOf(`id="scroll-result"`);
  const end = html.indexOf("</div></div>", start);
  return [...html.slice(start, end).matchAll(/<div class="(line(?: [^"]*)?)"/g)].map((match) => match[1]);
}

// A left insertion before b (an empty result range), a right change of c, and a right addition at the end.
const BASE = "a\nb\nc\nd";
const LEFT = "a\nX\nb\nc\nd";
const RIGHT = "a\nb\nC\nd\nE";

describe("resultLineClasses", () => {
  const start = startMerge(BASE, LEFT, RIGHT);

  it.each([
    ["a fresh merge", start],
    ["a resolved chunk", ignoreSide(start, 1, "right")],
    ["a split inside a chunk", splitLine(start, 2, 1)],
    ["a join across a gap", joinWithPrevious(start, 1)],
  ])("matches the host's result line classes for %s", (_label, state) => {
    const html = render(state);
    const data = clientData(html);

    const classes = loadMergeLines().resultLineClasses(data.chunks, data.resultLineCount);

    expect(classes).toEqual(renderedResultClasses(html));
  });

  it("marks gaps before a line and after the last line", () => {
    const classes = loadMergeLines().resultLineClasses(clientData(render(start)).chunks, 4);

    expect(classes).toEqual(["line", "line gap-before gap-added", "line chg-modified", "line gap-after gap-added"]);
  });
});

describe("pastedLines", () => {
  it.each([
    ["\\n", "x\ny"],
    ["\\r\\n", "x\r\ny"],
    ["\\r", "x\ry"],
  ])("splits pasted text on %s between the text around the caret", (_label, text) => {
    expect(loadMergeLines().pastedLines("ab", text, "cd")).toEqual(["abx", "ycd"]);
  });

  it("keeps empty lines, including a trailing line break", () => {
    expect(loadMergeLines().pastedLines("", "x\n\ny\n", "")).toEqual(["x", "", "y", ""]);
  });

  it.each([
    ["no text", "", ["abcd"]],
    ["text without a line break", "x", ["abxcd"]],
  ])("joins the text around the selection when it gives way to %s", (_label, text, lines) => {
    expect(loadMergeLines().pastedLines("ab", text, "cd")).toEqual(lines);
  });
});

describe("editedLines", () => {
  it.each([
    [{ type: "splitLine", line: 3, offset: 1 }, { line: 3, removed: 1, added: 2 }],
    [{ type: "joinWithPrevious", line: 3 }, { line: 2, removed: 2, added: 1 }],
    [{ type: "replaceLines", line: 3, count: 2, lines: ["a", "b", "c"] }, { line: 3, removed: 2, added: 3 }],
  ])("gives the lines %j replaces", (message, shape) => {
    expect(loadMergeLines().editedLines(message)).toEqual(shape);
  });

  it("matches the host's reckoning", () => {
    const message = { type: "replaceLines", line: 3, count: 2, lines: ["a", "b", "c"], seq: 1 } as const;

    expect(loadMergeLines().editedLines(message)).toEqual(editedLinesOnHost(message));
  });
});

describe("lineAfterEdits", () => {
  const edits = [{ line: 2, removed: 1, added: 2 }, { line: 6, removed: 2, added: 1 }];

  it.each([
    [1, 1],
    [2, null],
    [3, 4],
    [4, 5],
    [5, null],
    [6, null],
    [7, 7],
  ])("follows line %i through the edits made since", (line, expected) => {
    expect(loadMergeLines().lineAfterEdits(edits, line)).toBe(expected);
  });
});
