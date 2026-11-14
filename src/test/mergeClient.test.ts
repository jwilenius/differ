import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMerge, tallyMerge } from "../model/mergeSession";
import { describeMerge } from "../model/mergeView";
import type { HighlightedText } from "../model/syntaxTokens";
import { HtmlMergeViewRenderer } from "../render/html/mergeViewRenderer";
import { MergePage, type FakeElement, type FakeText, type PostedMessage } from "./mergeClientFixture";

const PAGE = 3;
const EDIT_DEBOUNCE_MS = 400;
// A left insertion before b, a right change of c, and a right addition at the end: none conflict.
const BASE = "a\nb\nc\nd";
const LEFT = "a\nX\nb\nc\nd";
const RIGHT = "a\nb\nC\nd\nE";

function unstyled(lines: readonly string[]): HighlightedText {
  return { styles: [{ color: null, fontStyle: 0 }], lines: lines.map((line) => [{ length: line.length, styleIndex: 0 }]) };
}

function openPage(): MergePage {
  const state = startMerge(BASE, LEFT, RIGHT);
  const input = {
    state,
    chunks: describeMerge(state, { wordLevel: true }),
    tally: tallyMerge(state),
    leftHighlight: unstyled(state.leftLines),
    rightHighlight: unstyled(state.rightLines),
    resultHighlight: unstyled(state.resultLines),
  };
  const html = new HtmlMergeViewRenderer().render(input, {
    nonce: "abcdefghijklmnop0123",
    cspSource: "https://res",
    title: "Merge: a.ts",
    styleUris: [],
    scriptUris: [],
    leftLabel: "main",
    rightLabel: "feature",
    resultPath: "a.ts",
    isSidesSwapped: false,
    page: PAGE,
    caret: null,
  });
  return new MergePage(html);
}

function editLine(line: number, text: string): PostedMessage {
  return { type: "editLine", line, text, page: PAGE };
}

function textOf(cell: FakeElement): FakeText {
  return cell.childNodes[0] as FakeText;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a held-back result edit", () => {
  it("is sent once typing pauses", () => {
    const page = openPage();

    page.type(page.resultCell(0), "a!");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS - 1);
    const heldBack = [...page.posted];
    vi.advanceTimersByTime(1);

    expect(heldBack).toEqual([]);
    expect(page.posted).toEqual([editLine(0, "a!")]);
  });

  it.each<[string, (page: MergePage, cell: FakeElement) => void, string]>([
    ["Ctrl+Z", (page, cell) => page.key(cell, { key: "z", keyCode: 90, ctrlKey: true }), "undo"],
    ["Ctrl+Shift+Z", (page, cell) => page.key(cell, { key: "Z", keyCode: 90, ctrlKey: true, shiftKey: true }), "redo"],
    ["Ctrl+Y", (page, cell) => page.key(cell, { key: "y", keyCode: 89, ctrlKey: true }), "redo"],
    ["a historyUndo beforeinput", (page, cell) => page.beforeInput(cell, "historyUndo"), "undo"],
    ["a historyRedo beforeinput", (page, cell) => page.beforeInput(cell, "historyRedo"), "redo"],
    ["the browser's own undo in the result", (page, cell) => page.input(cell, "historyUndo"), "undo"],
    ["the browser's own redo in the result", (page, cell) => page.input(cell, "historyRedo"), "redo"],
    ["the menu's undo taken by the history seed", (page) => page.input(page.historySeed(), "historyUndo"), "undo"],
    ["the menu's redo taken by the history seed", (page) => page.input(page.historySeed(), "historyRedo"), "redo"],
  ])("is sent before the step that %s asks for", (_label, step, type) => {
    const page = openPage();
    const cell = page.resultCell(0);
    page.type(cell, "a!");

    step(page, cell);
    vi.runAllTimers();

    expect(page.posted).toEqual([editLine(0, "a!"), { type, page: PAGE }]);
  });

  it("is sent before the page answers the host's redrawing notice", () => {
    const page = openPage();
    page.type(page.resultCell(0), "a!");

    page.receive({ type: "redrawing", page: PAGE });
    vi.runAllTimers();

    expect(page.posted).toEqual([editLine(0, "a!"), { type: "redrawReady", page: PAGE }]);
  });

  it.each<[string, (button: FakeElement) => boolean, Record<string, unknown>]>([
    ["Apply", (button) => button.id === "apply", { type: "apply" }],
    ["Cancel", (button) => button.id === "cancel", { type: "cancel" }],
    ["Accept Left", (button) => button.dataset.accept === "left", { type: "acceptSide", side: "left" }],
    ["Accept Right", (button) => button.dataset.accept === "right", { type: "acceptSide", side: "right" }],
    ["apply non-conflicting changes", (button) => button.dataset.nonConflicting === "all", { type: "applyNonConflicting", scope: "all" }],
    ["a chunk's accept arrow", (button) => button.dataset.side === "left" && button.dataset.action === "apply", { type: "applySide", chunk: 0, side: "left" }],
    ["a chunk's ignore cross", (button) => button.dataset.side === "right" && button.dataset.action === "ignore", { type: "ignoreSide", chunk: 1, side: "right" }],
  ])("is sent before the %s action", (_label, isButton, action) => {
    const page = openPage();
    page.type(page.resultCell(0), "a!");

    page.click(page.button(isButton));
    vi.runAllTimers();

    expect(page.posted).toEqual([editLine(0, "a!"), { ...action, page: PAGE }]);
  });

  it.each<[string, (page: MergePage) => void, PostedMessage[]]>([
    [
      "a line split",
      (page) => {
        page.type(page.resultCell(0), "a!");
        page.key(page.resultCell(0), { key: "Enter" });
      },
      [editLine(0, "a!"), { type: "splitLine", line: 0, offset: 2, seq: 1, page: PAGE }],
    ],
    [
      "a join with the line above",
      (page) => {
        page.type(page.resultCell(1), "b!");
        page.placeCaret(page.resultCell(1), 0);
        page.key(page.resultCell(1), { key: "Backspace" });
      },
      [editLine(1, "b!"), { type: "joinWithPrevious", line: 1, seq: 1, page: PAGE }],
    ],
    [
      "a paste of lines",
      (page) => {
        page.type(page.resultCell(0), "a!");
        page.paste(page.resultCell(0), "x\ny");
      },
      [editLine(0, "a!"), { type: "replaceLines", line: 0, count: 1, lines: ["a!x", "y"], seq: 1, page: PAGE }],
    ],
  ])("is sent before %s", (_label, edit, expected) => {
    const page = openPage();

    edit(page);
    vi.runAllTimers();

    expect(page.posted).toEqual(expected);
  });
});

describe("after Apply", () => {
  it("takes no more edits or actions", () => {
    const page = openPage();
    const cell = page.resultCell(0);
    page.type(cell, "a!");
    page.click(page.button((button) => button.id === "apply"));

    page.type(cell, "a!!");
    page.key(cell, { key: "Enter" });
    page.click(page.button((button) => button.dataset.accept === "left"));
    vi.runAllTimers();

    expect(page.posted).toEqual([editLine(0, "a!"), { type: "apply", page: PAGE }]);
    expect(page.document.getElementById("scroll-result")!.inert).toBe(true);
    expect(page.document.querySelectorAll("button").every((button) => button.disabled)).toBe(true);
  });
});

describe("the browser's own undo in the result", () => {
  it("is put back, latest change first, before the step goes to the host", () => {
    const page = openPage();
    const cell = page.resultCell(0);
    page.type(cell, "abc");
    const typed = textOf(cell);
    page.browserChangesText(typed, "ab");
    page.browserChangesText(typed, "");
    page.browserRemoves(typed);
    const shownAtStep: string[] = [];
    page.onPost = (message) => {
      if (message.type === "undo") {
        shownAtStep.push(cell.textContent);
      }
    };

    page.input(cell, "historyUndo");

    expect(shownAtStep).toEqual(["abc"]);
    expect(page.posted).toEqual([editLine(0, "abc"), { type: "undo", page: PAGE }]);
  });
});
