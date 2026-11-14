import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMerge, tallyMerge } from "../model/mergeSession";
import { describeMerge } from "../model/mergeView";
import type { HighlightedText } from "../model/syntaxTokens";
import { HtmlMergeViewRenderer } from "../render/html/mergeViewRenderer";
import { MergePage, type FakeElement, type FakeNode, type FakeText, type PostedMessage } from "./mergeClientFixture";

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

    expect(page.posted).toEqual([editLine(0, "a!"), { type: "redrawReady", caret: null, page: PAGE }]);
  });

  it("answers the host's redrawing notice with where the caret is in the result, for the new page", () => {
    const page = openPage();
    const cell = page.resultCell(1);
    cell.focus();
    page.type(cell, "b!");

    page.receive({ type: "redrawing", page: PAGE });

    expect(page.posted).toEqual([editLine(1, "b!"), { type: "redrawReady", caret: { line: 1, column: 2 }, page: PAGE }]);
  });

  it("names no caret in its answer while the focus is outside the result", () => {
    const page = openPage();
    page.type(page.resultCell(1), "b!");
    page.button((button) => button.dataset.accept === "left").focus();

    page.receive({ type: "redrawing", page: PAGE });

    expect(page.posted).toEqual([editLine(1, "b!"), { type: "redrawReady", caret: null, page: PAGE }]);
  });

  it("names no caret in its answer while the page has no focus", () => {
    const page = openPage();
    const cell = page.resultCell(1);
    cell.focus();
    page.type(cell, "b!");
    page.document.isFocused = false;

    page.receive({ type: "redrawing", page: PAGE });

    expect(page.posted).toEqual([editLine(1, "b!"), { type: "redrawReady", caret: null, page: PAGE }]);
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
    [
      "a removal of a selection across lines",
      (page) => {
        page.type(page.resultCell(0), "a!");
        page.select(textOf(page.resultCell(0)), 1, textOf(page.resultCell(1)), 0);
        page.key(page.resultCell(0), { key: "Delete" });
      },
      [editLine(0, "a!"), { type: "replaceLines", line: 0, count: 2, lines: ["ab"], seq: 1, page: PAGE }],
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

  it("takes no edits over a selection across lines", () => {
    const page = openPage();
    page.type(page.resultCell(0), "a!");
    page.click(page.button((button) => button.id === "apply"));
    page.select(textOf(page.resultCell(0)), 1, textOf(page.resultCell(2)), 0);

    page.key(page.document.body, { key: "Delete" });
    page.key(page.document.body, { key: "x" });
    const cut = page.cut(page.document.body);
    vi.runAllTimers();

    expect(cut).toBeNull();
    expect(page.posted).toEqual([editLine(0, "a!"), { type: "apply", page: PAGE }]);
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

describe("copying a selection across lines", () => {
  function paneLines(page: MergePage, pane: string): FakeElement[] {
    return page.document.getElementById(`scroll-${pane}`)!.querySelectorAll(".line");
  }

  function codeOf(line: FakeElement): FakeElement {
    return line.querySelector(".code")!;
  }

  function numberOf(line: FakeElement): FakeText {
    return line.querySelector(".num")!.childNodes[0] as FakeText;
  }

  it("copies a side's text without its line numbers or gutter buttons", () => {
    const page = openPage();
    const lines = paneLines(page, "left");
    page.select(textOf(codeOf(lines[1]!)), 0, textOf(codeOf(lines[3]!)), 1);

    expect(page.copy(page.document.body)).toBe("X\nb\nc");
  });

  it("copies the result's text from a drag started in the line numbers", () => {
    const page = openPage();
    const lines = paneLines(page, "result");
    page.select(numberOf(lines[1]!), 0, textOf(codeOf(lines[2]!)), 1);

    expect(page.copy(page.document.body)).toBe("b\nc");
  });

  it("leaves a selection within one line to the browser", () => {
    const page = openPage();
    const code = codeOf(paneLines(page, "left")[1]!);
    page.select(textOf(code), 0, textOf(code), 1);

    expect(page.copy(page.document.body)).toBeNull();
  });
});

describe("a selection across result lines", () => {
  /** The result line and column of a selection end, which lies in a cell's only text node. */
  function pointOf(node: FakeNode | null, offset: number): { line: number; column: number } {
    return { line: Number(node!.parentElement!.closest(".code[data-line]")!.dataset.line), column: offset };
  }

  function selectionOf(page: MergePage): { anchor: { line: number; column: number }; focus: { line: number; column: number } } {
    const { selection } = page.window;
    return { anchor: pointOf(selection.anchorNode, selection.anchorOffset), focus: pointOf(selection.focusNode, selection.focusOffset) };
  }

  function resultTexts(page: MergePage): string[] {
    return page.document.getElementById("scroll-result")!.querySelectorAll(".code[data-line]").map((cell) => cell.textContent);
  }

  function selectFromLine0To2(page: MergePage): void {
    page.select(textOf(page.resultCell(0)), 1, textOf(page.resultCell(2)), 0);
  }

  function replaceLines(line: number, count: number, lines: readonly string[]): PostedMessage {
    return { type: "replaceLines", line, count, lines, seq: 1, page: PAGE };
  }

  it.each<[string, Record<string, unknown>, string[], { line: number; column: number }]>([
    ["Backspace", { key: "Backspace" }, ["ac"], { line: 0, column: 1 }],
    ["Delete", { key: "Delete" }, ["ac"], { line: 0, column: 1 }],
    ["a typed character", { key: "x", keyCode: 88 }, ["axc"], { line: 0, column: 2 }],
    ["a character typed with AltGr", { key: "@", ctrlKey: true, altKey: true }, ["a@c"], { line: 0, column: 2 }],
    ["Enter", { key: "Enter" }, ["a", "c"], { line: 1, column: 0 }],
  ])("is replaced as one edit on %s", (_label, key, lines, caret) => {
    const page = openPage();
    selectFromLine0To2(page);

    page.key(page.resultCell(0), key);

    expect(page.posted).toEqual([replaceLines(0, 3, lines)]);
    expect(resultTexts(page)).toEqual([...lines, "d"]);
    expect(selectionOf(page).focus).toEqual(caret);
    expect(page.window.selection.isCollapsed).toBe(true);
  });

  it("dragged from the line numbers is replaced on a key the page gets outside the result", () => {
    const page = openPage();
    const number = page.resultCell(1).parentElement!.querySelector(".num")!.childNodes[0]!;
    page.select(number, 0, textOf(page.resultCell(2)), 1);

    page.key(page.document.body, { key: "Delete" });

    expect(page.posted).toEqual([replaceLines(1, 2, [""])]);
    expect(resultTexts(page)).toEqual(["a", "", "d"]);
  });

  it("is replaced by text the browser inserts", () => {
    const page = openPage();
    selectFromLine0To2(page);

    page.beforeInput(page.resultCell(0), "insertText", "xy");

    expect(page.posted).toEqual([replaceLines(0, 3, ["axyc"])]);
  });

  it("is cut to the clipboard as one edit", () => {
    const page = openPage();
    selectFromLine0To2(page);

    const cut = page.cut(page.document.body);

    expect(cut).toBe("\nb\n");
    expect(page.posted).toEqual([replaceLines(0, 3, ["ac"])]);
    expect(resultTexts(page)).toEqual(["ac", "d"]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a shortcut", { key: "a", ctrlKey: true }],
    ["a named key", { key: "Tab" }],
    ["a modifier", { key: "Shift", shiftKey: true }],
    ["Shift+Delete, which the browser makes a cut", { key: "Delete", shiftKey: true }],
    ["an IME's first key", { key: "Process", keyCode: 229 }],
    ["a key of an IME composition", { key: "x", isComposing: true }],
  ])("is left to the browser on %s", (_label, key) => {
    const page = openPage();
    selectFromLine0To2(page);

    page.key(page.resultCell(0), key);

    expect(page.posted).toEqual([]);
    expect(resultTexts(page)).toEqual(["a", "b", "c", "d"]);
  });

  it("grows by Shift+↓ to the line below, keeping the column", () => {
    const page = openPage();
    page.placeCaret(page.resultCell(0), 1);

    page.key(page.resultCell(0), { key: "ArrowDown", shiftKey: true });
    page.key(page.resultCell(0), { key: "ArrowDown", shiftKey: true });

    expect(selectionOf(page)).toEqual({ anchor: { line: 0, column: 1 }, focus: { line: 2, column: 1 } });
    expect(page.posted).toEqual([]);
  });

  it("grows by Shift+↑ to the line above, before its anchor", () => {
    const page = openPage();
    page.placeCaret(page.resultCell(2), 0);

    page.key(page.resultCell(2), { key: "ArrowUp", shiftKey: true });
    page.key(page.resultCell(2), { key: "ArrowUp", shiftKey: true });
    page.key(page.resultCell(2), { key: "x" });

    expect(page.posted).toEqual([replaceLines(0, 3, ["xc"])]);
  });

  it.each<[string, string, number, { line: number; column: number }]>([
    ["Shift+↓ on the last line to its end", "ArrowDown", 3, { line: 3, column: 1 }],
    ["Shift+↑ on the first line to its start", "ArrowUp", 0, { line: 0, column: 0 }],
  ])("grows by %s", (_label, key, line, focus) => {
    const page = openPage();
    page.placeCaret(page.resultCell(line), line === 0 ? 1 : 0);

    page.key(page.resultCell(line), { key, shiftKey: true });

    expect(selectionOf(page).focus).toEqual(focus);
  });

  it.each(["ctrlKey", "altKey", "metaKey"])("leaves ↓ with %s to the browser", (modifier) => {
    const page = openPage();
    page.placeCaret(page.resultCell(0), 1);

    page.key(page.resultCell(0), { key: "ArrowDown", [modifier]: true });

    expect(selectionOf(page)).toEqual({ anchor: { line: 0, column: 1 }, focus: { line: 0, column: 1 } });
  });
});

describe("Enter over a selection within a result line", () => {
  it("replaces the selection with a line break as one edit, after the held-back edit", () => {
    const page = openPage();
    page.type(page.resultCell(0), "abc");
    page.select(textOf(page.resultCell(0)), 1, textOf(page.resultCell(0)), 2);

    page.key(page.resultCell(0), { key: "Enter" });
    vi.runAllTimers();

    expect(page.posted).toEqual([
      editLine(0, "abc"),
      { type: "replaceLines", line: 0, count: 1, lines: ["a", "c"], seq: 1, page: PAGE },
    ]);
    const cells = page.document.getElementById("scroll-result")!.querySelectorAll(".code[data-line]");
    expect(cells.map((cell) => cell.textContent)).toEqual(["a", "c", "b", "c", "d"]);
    const { selection } = page.window;
    expect(selection.isCollapsed).toBe(true);
    expect(selection.focusNode!.parentElement!.closest(".code[data-line]")).toBe(cells[1]);
    expect(selection.focusOffset).toBe(0);
  });
});
