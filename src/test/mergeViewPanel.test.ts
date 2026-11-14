import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { listUnmergedEntries } from "../git/gitConflictedFiles";
import { type HighlightOptions, unstyledText } from "../highlight/textMateHighlighter";
import { MergeViewPanel } from "../host/vscode/mergeViewPanel";
import type { TextHighlighter } from "../host/vscode/twoWayDiffPanel";
import { createConflictRepository, divergeBranches, mergeFeature, runGit } from "./gitConflictFixture";
import { ColorThemeKind, changeColorThemeKind, type FakeWebview, fireDidCloseTextDocument, resetVscodeMock, vscodeMock } from "./vscodeMock";

let repo: string;
let outside: string;

/**
 * A file document whose save writes the last applied edit to disk, following symbolic links as the editor's save does.
 * Like VS Code's, it refuses to save once closed.
 */
function fileDocument(filePath: string): vscode.TextDocument {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  const document = {
    uri: vscode.Uri.file(filePath),
    languageId: "plaintext",
    eol: vscode.EndOfLine.LF,
    lineCount: lines.length,
    isClosed: false,
    getText: () => text,
    lineAt: (line: number) => ({ range: new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, lines[line].length)) }),
    save: async (): Promise<boolean> => {
      if (document.isClosed) {
        throw new Error("Document has been closed");
      }
      fs.writeFileSync(filePath, vscodeMock.appliedEdits.at(-1)?.text ?? text);
      return true;
    },
  };
  return document as unknown as vscode.TextDocument;
}

/** Closes a document as VS Code does when its tab closes or an unshown document is collected. */
function closeDocument(document: vscode.TextDocument): void {
  (document as { isClosed: boolean }).isClosed = true;
  fireDidCloseTextDocument(document);
}

/** A file document that fails once git's stages are read, as reading its line ending does. */
function failingDocument(filePath: string): vscode.TextDocument {
  return Object.defineProperty(fileDocument(filePath), "eol", {
    get: () => {
      throw new Error("The document failed.");
    },
  });
}

const plainHighlighter: TextHighlighter = { highlight: async (text: string) => unstyledText(text) };

function createPanel(document: vscode.TextDocument, highlighter = plainHighlighter): Promise<MergeViewPanel> {
  vscodeMock.textDocuments.push(document);
  return MergeViewPanel.create({
    document,
    mediaRoot: vscode.Uri.file(os.tmpdir()),
    highlighter,
    log: () => undefined,
    onDispose: () => undefined,
  });
}

/** The number of the page the webview shows. */
function shownPage(webview: FakeWebview): number {
  return Number(/id="merge" data-page="(\d+)"/.exec(webview.html)?.[1]);
}

/** The messages of one type the panel posted to its webview. */
function postedOfType(webview: FakeWebview, type: string): unknown[] {
  return webview.postedMessages.filter((message) => (message as { type: string }).type === type);
}

/** Delivers a message as the page the webview shows posts it, stamped with its number. */
function post(webview: FakeWebview, message: Readonly<Record<string, unknown>>): void {
  webview.fireDidReceiveMessage({ ...message, page: shownPage(webview) });
}

async function openPanel(document: vscode.TextDocument): Promise<FakeWebview> {
  await createPanel(document);
  return vscodeMock.webviewPanels[0].webview;
}

beforeEach(() => {
  resetVscodeMock();
  vscodeMock.openFileDocument = (uri) => fileDocument(uri.fsPath);
  repo = createConflictRepository();
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "differ-outside-"));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("MergeViewPanel apply", () => {
  it("refuses to write or stage a file that became a symbolic link", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const target = path.join(outside, "target.txt");
    fs.writeFileSync(target, "precious\n");
    const webview = await openPanel(fileDocument(file));
    fs.rmSync(file);
    fs.symlinkSync(target, file);

    post(webview, { type: "acceptSide", side: "left" });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.messages).toHaveLength(1));
    expect(vscodeMock.messages[0].level).toBe("error");
    expect(vscodeMock.messages[0].text).toContain("symbolic link");
    expect(fs.readFileSync(target, "utf8")).toBe("precious\n");
    expect(await listUnmergedEntries(repo, ["f.txt"])).not.toEqual([]);
  });
});

describe("MergeViewPanel apply after VS Code closed the document", () => {
  it("writes and stages the result through a freshly opened document", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const document = fileDocument(file);
    const webview = await openPanel(document);
    closeDocument(document);
    fs.appendFileSync(file, "changed while closed\n");
    const lastLine = fs.readFileSync(file, "utf8").split("\n").length - 1;

    post(webview, { type: "acceptSide", side: "left" });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(vscodeMock.messages).toEqual([]);
    expect(vscodeMock.appliedEdits.at(-1)?.range.end.line).toBe(lastLine);
    expect(fs.readFileSync(file, "utf8")).toBe("trunk\n");
    expect(await listUnmergedEntries(repo, ["f.txt"])).toEqual([]);
  });

  it("creates and stages the file when it was deleted as well", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const document = fileDocument(file);
    const webview = await openPanel(document);
    closeDocument(document);
    fs.rmSync(file);
    vscodeMock.openFileDocument = (uri) => {
      throw new Error(`cannot open ${uri.fsPath}: file not found`);
    };

    post(webview, { type: "acceptSide", side: "left" });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(vscodeMock.messages).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("trunk\n");
    expect(await listUnmergedEntries(repo, ["f.txt"])).toEqual([]);
  });
});

describe("MergeViewPanel apply after confirming an unresolved result", () => {
  it("refuses a file that became a symbolic link while the confirmation was open", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const target = path.join(outside, "target.txt");
    fs.writeFileSync(target, "precious\n");
    const webview = await openPanel(fileDocument(file));
    vscodeMock.warningMessageResponse = () => {
      fs.rmSync(file);
      fs.symlinkSync(target, file);
      return "Apply";
    };

    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.messages.map(({ level }) => level)).toEqual(["warning", "error"]));
    expect(vscodeMock.messages[1].text).toContain("symbolic link");
    expect(fs.readFileSync(target, "utf8")).toBe("precious\n");
  });

  it("writes the result when the file was deleted, as saving recreates it", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    vscodeMock.warningMessageResponse = () => {
      fs.rmSync(file);
      return "Apply";
    };

    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(vscodeMock.messages.map(({ level }) => level)).toEqual(["warning"]);
    expect(fs.readFileSync(file, "utf8")).toBe(vscodeMock.appliedEdits.at(-1)?.text);
  });

  it("reports a failed apply when the panel was closed while the confirmation was open", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const document = fileDocument(path.join(repo, "f.txt"));
    const webview = await openPanel(document);
    vscodeMock.warningMessageResponse = () => {
      vscodeMock.webviewPanels[0].dispose();
      closeDocument(document);
      vscodeMock.openFileDocument = () => {
        throw new Error("The file cannot be opened.");
      };
      return "Apply";
    };

    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.messages.map(({ level }) => level)).toEqual(["warning", "error"]));
    expect(vscodeMock.messages[1].text).toBe("Differ could not complete the merge action. The file cannot be opened.");
  });
});

describe("MergeViewPanel that fails to load", () => {
  it("closes its panel instead of leaving it blank", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);

    await expect(createPanel(failingDocument(path.join(repo, "f.txt")))).rejects.toThrow("The document failed.");

    expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true);
  });
});

describe("MergeViewPanel closed while it loads", () => {
  it("opens without error when an unmergeable file's panel is closed while git's stages are read", async () => {
    divergeBranches(repo, ["f.txt"]);
    runGit(repo, "checkout", "-q", "feature");
    runGit(repo, "rm", "-q", "f.txt");
    runGit(repo, "commit", "-qm", "delete");
    runGit(repo, "checkout", "-q", "trunk");
    mergeFeature(repo);

    const opening = createPanel(fileDocument(path.join(repo, "f.txt")));
    vscodeMock.webviewPanels[0].dispose();

    await expect(opening).resolves.toBeInstanceOf(MergeViewPanel);
    expect(vscodeMock.webviewPanels[0].webview.html).toBe("");
  });

  it("opens without error when a mergeable file's panel is closed while git's stages are read", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);

    const opening = createPanel(fileDocument(path.join(repo, "f.txt")));
    vscodeMock.webviewPanels[0].dispose();

    await expect(opening).resolves.toBeInstanceOf(MergeViewPanel);
    expect(vscodeMock.webviewPanels[0].webview.html).toBe("");
  });

  it("opens without error when closed while highlighting", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const closingHighlighter: TextHighlighter = {
      highlight: async (text: string) => {
        vscodeMock.webviewPanels[0].dispose();
        return unstyledText(text);
      },
    };

    const opening = createPanel(fileDocument(path.join(repo, "f.txt")), closingHighlighter);

    await expect(opening).resolves.toBeInstanceOf(MergeViewPanel);
    expect(vscodeMock.webviewPanels[0].webview.html).toBe("");
  });

  it("opens without error when closed while highlighting fails", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const failingHighlighter: TextHighlighter = {
      highlight: async () => {
        vscodeMock.webviewPanels[0].dispose();
        throw new Error("Highlighting failed.");
      },
    };

    const opening = createPanel(fileDocument(path.join(repo, "f.txt")), failingHighlighter);

    await expect(opening).resolves.toBeInstanceOf(MergeViewPanel);
    expect(vscodeMock.messages).toEqual([]);
  });
});

describe("MergeViewPanel for a conflict it cannot merge", () => {
  it("says why instead of claiming no merge is in progress", async () => {
    divergeBranches(repo, ["f.txt"]);
    runGit(repo, "checkout", "-q", "feature");
    runGit(repo, "rm", "-q", "f.txt");
    runGit(repo, "commit", "-qm", "delete");
    runGit(repo, "checkout", "-q", "trunk");
    mergeFeature(repo);

    await openPanel(fileDocument(path.join(repo, "f.txt")));

    const { html } = vscodeMock.webviewPanels[0].webview;
    expect(html).not.toContain("No merge in progress");
    expect(html).toContain("Differ cannot merge f.txt");
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`);
  });
});

describe("MergeViewPanel edit the page and merge no longer agree on", () => {
  it.each([
    ["a line break the message cannot carry", { type: "editLine", line: 0, text: "a\nb" }],
    ["a line the result does not have", { type: "editLine", line: 99, text: "x" }],
    ["a split beyond the result", { type: "splitLine", line: 99, offset: 0, seq: 1 }],
    ["a join onto no line", { type: "joinWithPrevious", line: 0, seq: 1 }],
    ["pasted lines replacing no line", { type: "replaceLines", line: 99, count: 1, lines: ["a", "b"], seq: 1 }],
    ["pasted lines replacing lines past the end", { type: "replaceLines", line: 1, count: 2, lines: ["a", "b"], seq: 1 }],
  ])("redraws the page for %s", async (_label, message) => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));
    const page = webview.html;

    post(webview, message);

    await vi.waitFor(() => expect(webview.html).not.toBe(page));
  });

  it("drops what the page sends after the rejected edit, whose lines may assume it", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    const page = shownPage(webview);
    vscodeMock.warningMessageResponse = () => "Apply";

    post(webview, { type: "replaceLines", line: 1, count: 2, lines: ["a", "b"], seq: 1 });
    post(webview, { type: "editLine", line: 0, text: "sent before the redraw" });
    await vi.waitFor(() => expect(shownPage(webview)).not.toBe(page));
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(fs.readFileSync(file, "utf8")).toBe("base\n");
  });
});

describe("MergeViewPanel typing in the result", () => {
  it("keeps the page while the merge takes the edit, and applies it", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    const page = webview.html;
    vscodeMock.warningMessageResponse = () => "Apply";

    post(webview, { type: "editLine", line: 0, text: "typed" });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(webview.html).toBe(page);
    expect(fs.readFileSync(file, "utf8")).toBe("typed\n");
  });

  it("shows an edit made while a resolved chunk is being drawn", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    let isTypingDuringRender = false;
    const typingHighlighter: TextHighlighter = {
      highlight: async (text: string) => {
        if (isTypingDuringRender) {
          isTypingDuringRender = false;
          post(vscodeMock.webviewPanels[0].webview, { type: "editLine", line: 0, text: "typed meanwhile" });
        }
        return unstyledText(text);
      },
    };
    await createPanel(fileDocument(path.join(repo, "f.txt")), typingHighlighter);
    const { webview } = vscodeMock.webviewPanels[0];
    const page = webview.html;
    isTypingDuringRender = true;

    post(webview, { type: "ignoreSide", chunk: 0, side: "right" });

    await vi.waitFor(() => expect(webview.html).not.toBe(page));
    await vi.waitFor(() => expect(webview.html).toContain("typed meanwhile"));
  });
});

describe("MergeViewPanel undo and redo", () => {
  /** Posts a message that redraws the page and waits for the new page. */
  async function postAndRedraw(webview: FakeWebview, message: Readonly<Record<string, unknown>>): Promise<void> {
    const page = shownPage(webview);
    post(webview, message);
    await vi.waitFor(() => expect(shownPage(webview)).not.toBe(page));
  }

  async function applyAndRead(webview: FakeWebview, file: string): Promise<string> {
    vscodeMock.warningMessageResponse = () => "Apply";
    post(webview, { type: "apply" });
    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    return fs.readFileSync(file, "utf8");
  }

  it("takes back result edits and resolving actions one at a time, redrawing the page", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));

    post(webview, { type: "applySide", chunk: 0, side: "left" });
    await vi.waitFor(() => expect(shownPage(webview)).toBe(2));
    post(webview, { type: "editLine", line: 0, text: "one" });
    post(webview, { type: "splitLine", line: 0, offset: 1, seq: 1 });
    await postAndRedraw(webview, { type: "undo" });
    await postAndRedraw(webview, { type: "undo" });

    expect(/data-line="0">(.*?)<\/div>/.exec(webview.html)?.[1]).toContain(">trunk<");
    await postAndRedraw(webview, { type: "undo" });
    expect(await applyAndRead(webview, file)).toBe("base\n");
  });

  it("puts an undone edit back on redo", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));

    post(webview, { type: "editLine", line: 0, text: "one" });
    post(webview, { type: "editLine", line: 0, text: "two" });
    await postAndRedraw(webview, { type: "undo" });
    await postAndRedraw(webview, { type: "undo" });
    await postAndRedraw(webview, { type: "redo" });

    expect(await applyAndRead(webview, file)).toBe("one\n");
  });

  it("forgets what was undone once the result changes again", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));

    post(webview, { type: "editLine", line: 0, text: "one" });
    await postAndRedraw(webview, { type: "undo" });
    post(webview, { type: "editLine", line: 0, text: "two" });
    await postAndRedraw(webview, { type: "redo" });

    expect(await applyAndRead(webview, file)).toBe("two\n");
  });

  it("redraws the page with nothing to undo, as it stops taking edits until it is replaced", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));

    await postAndRedraw(webview, { type: "undo" });
    await postAndRedraw(webview, { type: "redo" });

    expect(await applyAndRead(webview, file)).toBe("base\n");
  });
});

describe("MergeViewPanel for a file with lone carriage returns", () => {
  /** Conflicts `f.txt` whose common ancestor is `base`, as `divergeBranches` does for its fixed texts. */
  function conflictFromBase(base: string): string {
    const file = path.join(repo, "f.txt");
    fs.writeFileSync(file, base);
    runGit(repo, "add", ".");
    runGit(repo, "commit", "-qm", "base");
    runGit(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(file, "feature\n");
    runGit(repo, "commit", "-qam", "feature");
    runGit(repo, "checkout", "-q", "trunk");
    fs.writeFileSync(file, "trunk\n");
    runGit(repo, "commit", "-qam", "trunk");
    mergeFeature(repo);
    return file;
  }

  it("breaks lines at them, as VS Code does, so every line can be edited and applied as shown", async () => {
    const file = conflictFromBase("one\rtwo\r\nthree\n");
    const webview = await openPanel(fileDocument(file));
    const page = webview.html;
    vscodeMock.warningMessageResponse = () => "Apply";

    post(webview, { type: "editLine", line: 1, text: "two!" });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(page).not.toContain("\r");
    expect(/data-line="1">(.*?)<\/div>/.exec(page)?.[1]).toContain(">two<");
    expect(webview.html).toBe(page);
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo!\nthree\n");
  });
});

describe("MergeViewPanel splitting and joining result lines", () => {
  it("keeps the page and answers each edit with the chunk layout it left", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    const page = webview.html;

    post(webview, { type: "splitLine", line: 0, offset: 2, seq: 1 });
    post(webview, { type: "splitLine", line: 1, offset: 1, seq: 2 });
    post(webview, { type: "joinWithPrevious", line: 2, seq: 3 });

    await vi.waitFor(() => expect(postedOfType(webview, "layout")).toHaveLength(3));
    expect(webview.html).toBe(page);
    expect(postedOfType(webview, "layout")[0]).toMatchObject({ page: shownPage(webview), seq: 1, data: { resultLineCount: 3, chunks: [{ result: [0, 2] }] } });
    expect(postedOfType(webview, "layout")[2]).toMatchObject({ seq: 3, data: { resultLineCount: 3, chunks: [{ result: [0, 2] }] } });
  });

  it("applies the split and joined lines", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    vscodeMock.warningMessageResponse = () => "Apply";

    post(webview, { type: "splitLine", line: 0, offset: 2, seq: 1 });
    post(webview, { type: "splitLine", line: 1, offset: 1, seq: 2 });
    post(webview, { type: "joinWithPrevious", line: 1, seq: 3 });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(fs.readFileSync(file, "utf8")).toBe("bas\ne\n");
  });
});

describe("MergeViewPanel pasting lines into the result", () => {
  it("keeps the page, answers with the chunk layout and applies the lines", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    const page = webview.html;
    vscodeMock.warningMessageResponse = () => "Apply";

    post(webview, { type: "replaceLines", line: 0, count: 1, lines: ["one", "two", "base"], seq: 1 });

    await vi.waitFor(() => expect(postedOfType(webview, "layout")).toHaveLength(1));
    expect(webview.html).toBe(page);
    expect(postedOfType(webview, "layout")[0]).toMatchObject({ seq: 1, data: { resultLineCount: 4, chunks: [{ result: [0, 3] }] } });

    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\nbase\n");
  });
});

describe("MergeViewPanel pasting lines over several result lines", () => {
  it("replaces them and applies the pasted lines", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    vscodeMock.warningMessageResponse = () => "Apply";

    post(webview, { type: "replaceLines", line: 0, count: 2, lines: ["one", "two", "three"], seq: 1 });

    await vi.waitFor(() => expect(postedOfType(webview, "layout")).toHaveLength(1));
    expect(postedOfType(webview, "layout")[0]).toMatchObject({ seq: 1, data: { resultLineCount: 3 } });

    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\nthree");
  });
});

describe("MergeViewPanel highlighting edited result lines", () => {
  const PLAIN = { color: null, fontStyle: 0 };
  const KEYWORD = { color: "#569cd6", fontStyle: 0 };
  /** Colours lines starting with "kw" as keywords, numbering styles in first-use order as TextMate does, so tables differ between runs. */
  const keywordHighlighter: TextHighlighter = {
    highlight: async (text: string) => {
      const lineStyles = text.split("\n").map((line) => (line.startsWith("kw") ? KEYWORD : PLAIN));
      const styles = [...new Set(lineStyles)];
      return { styles, lines: text.split("\n").map((line, index) => [{ length: line.length, styleIndex: styles.indexOf(lineStyles[index]) }]) };
    },
  };

  it("sends the edited line coloured again, with the stylesheet its markup uses", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    await createPanel(fileDocument(path.join(repo, "f.txt")), keywordHighlighter);
    const { webview } = vscodeMock.webviewPanels[0];

    post(webview, { type: "editLine", line: 0, text: "kw base" });

    await vi.waitFor(() => expect(postedOfType(webview, "highlight")).toHaveLength(1));
    expect(postedOfType(webview, "highlight")[0]).toEqual({
      type: "highlight",
      page: shownPage(webview),
      seq: 0,
      styles: ".tk-result-1{color:#569cd6}",
      lines: [{ line: 0, text: "kw base", html: '<span class="tk-result-1">kw base</span>' }],
    });
  });

  it("numbers the update after the latest split and sends only the lines whose markup changed", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));

    post(webview, { type: "splitLine", line: 0, offset: 2, seq: 1 });

    await vi.waitFor(() => expect(postedOfType(webview, "highlight")).toHaveLength(1));
    expect(postedOfType(webview, "highlight")[0]).toMatchObject({ seq: 1, lines: [{ line: 0, text: "ba" }, { line: 1, text: "se" }] });
  });

  it("keeps the page's colours when highlighting the edited result fails", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    let isFailing = false;
    const failingHighlighter: TextHighlighter = {
      highlight: async (text, languageId, options) => {
        if (isFailing) {
          throw new Error("The grammar failed.");
        }
        return keywordHighlighter.highlight(text, languageId, options);
      },
    };
    await createPanel(fileDocument(path.join(repo, "f.txt")), failingHighlighter);
    const { webview } = vscodeMock.webviewPanels[0];
    post(webview, { type: "editLine", line: 0, text: "kw base" });
    await vi.waitFor(() => expect(postedOfType(webview, "highlight")).toHaveLength(1));
    isFailing = true;

    post(webview, { type: "editLine", line: 0, text: "kw based" });
    post(webview, { type: "splitLine", line: 0, offset: 2, seq: 1 });

    await vi.waitFor(() => expect(postedOfType(webview, "layout")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postedOfType(webview, "highlight")).toHaveLength(1);
  });

  it("stops highlighting for an edit a newer one overtook", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const signals: (AbortSignal | undefined)[] = [];
    const recordingHighlighter: TextHighlighter = {
      highlight: async (text: string, _languageId: string, options?: HighlightOptions) => {
        signals.push(options?.signal);
        return unstyledText(text);
      },
    };
    await createPanel(fileDocument(path.join(repo, "f.txt")), recordingHighlighter);
    const { webview } = vscodeMock.webviewPanels[0];
    const loadRuns = signals.length;

    post(webview, { type: "editLine", line: 0, text: "a" });
    post(webview, { type: "editLine", line: 0, text: "ab" });

    await vi.waitFor(() => expect(postedOfType(webview, "highlight")).toHaveLength(1));
    expect(signals.slice(loadRuns).map((signal) => signal?.aborted)).toEqual([true, false]);
  });

  it("sends nothing for an edit a newer one overtook", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));

    post(webview, { type: "editLine", line: 0, text: "a" });
    post(webview, { type: "editLine", line: 0, text: "ab" });

    await vi.waitFor(() => expect(postedOfType(webview, "highlight")).toHaveLength(1));
    expect(postedOfType(webview, "highlight")[0]).toMatchObject({ lines: [{ line: 0, text: "ab" }] });
  });
});

describe("MergeViewPanel messages from a replaced page", () => {
  it("drops an edit the replaced page sent, which the page now shown lacks", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    const firstPage = shownPage(webview);
    vscodeMock.warningMessageResponse = () => "Apply";

    post(webview, { type: "ignoreSide", chunk: 0, side: "right" });
    await vi.waitFor(() => expect(shownPage(webview)).not.toBe(firstPage));
    webview.fireDidReceiveMessage({ type: "editLine", line: 0, text: "typed on the replaced page", page: firstPage });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(fs.readFileSync(file, "utf8")).toBe("base\n");
  });

  it("does not answer a split the replaced page sent", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));
    const firstPage = shownPage(webview);

    post(webview, { type: "ignoreSide", chunk: 0, side: "right" });
    await vi.waitFor(() => expect(shownPage(webview)).not.toBe(firstPage));
    const redrawn = webview.html;
    webview.fireDidReceiveMessage({ type: "splitLine", line: 0, offset: 1, seq: 1, page: firstPage });
    post(webview, { type: "splitLine", line: 0, offset: 2, seq: 1 });

    const layouts = (): unknown[] => webview.postedMessages.filter((message) => (message as { type: string }).type === "layout");
    await vi.waitFor(() => expect(layouts()).toHaveLength(1));
    expect(webview.html).toBe(redrawn);
    expect(layouts()[0]).toMatchObject({ page: shownPage(webview), data: { resultLineCount: 3 } });
  });
});

describe("MergeViewPanel redrawing the page", () => {
  it("redraws for a resolving action that changes nothing, as the page stops taking edits until it is replaced", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));
    post(webview, { type: "ignoreSide", chunk: 0, side: "right" });
    await vi.waitFor(() => expect(shownPage(webview)).toBe(2));

    post(webview, { type: "ignoreSide", chunk: 0, side: "right" });

    await vi.waitFor(() => expect(shownPage(webview)).toBe(3));
  });

  it("tells the page before a colour theme change replaces it, so it sends the edit it holds back and stops taking more", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));

    changeColorThemeKind(ColorThemeKind.Light);

    expect(webview.postedMessages).toEqual([{ type: "redrawing", page: 1 }]);
    await vi.waitFor(() => expect(shownPage(webview)).toBe(2));
  });
});
