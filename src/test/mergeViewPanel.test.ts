import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { listUnmergedEntries } from "../git/gitConflictedFiles";
import { type HighlightOptions, unstyledText } from "../highlight/textMateHighlighter";
import { MergeViewPanel } from "../host/vscode/mergeViewPanel";
import type { TextHighlighter } from "../host/vscode/twoWayDiffPanel";
import { createConflictRepository, divergeBranches, divergeFile, mergeFeature, runGit } from "./gitConflictFixture";
import { type FakeElement, type FakeText, MergePage } from "./mergeClientFixture";
import { ColorThemeKind, changeColorThemeKind, type FakeWebview, fireDidCloseTextDocument, resetVscodeMock, vscodeMock } from "./vscodeMock";

let repo: string;
let outside: string;

const BYTE_ORDER_MARK = "\ufeff";

/**
 * A file document whose save writes the last applied edit to disk, following symbolic links as the editor's save does.
 * Like VS Code's, it refuses to save once closed, and keeps a UTF-8 byte order mark the file starts with out of its
 * text, writing it back on save; a mark at the start of the text of a file without one is saved as text.
 */
function fileDocument(filePath: string): vscode.TextDocument {
  const content = fs.readFileSync(filePath, "utf8");
  const byteOrderMark = content.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : "";
  const text = content.slice(byteOrderMark.length);
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
      fs.writeFileSync(filePath, byteOrderMark + (vscodeMock.appliedEdits.at(-1)?.text ?? text));
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
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "jw-differ-outside-"));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("MergeViewPanel find", () => {
  it("offers VS Code's find widget, so Ctrl+F searches the sides and the result", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);

    await openPanel(fileDocument(path.join(repo, "f.txt")));

    expect(vscodeMock.webviewPanels[0].options.enableFindWidget).toBe(true);
  });
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

describe("MergeViewPanel apply to a file with a byte order mark", () => {
  it("keeps the mark when the conflict on the first line left the working copy without it", async () => {
    divergeFile(repo, "f.txt", { base: "\ufeffbase\n", feature: "\ufefffeature\n", trunk: "\ufefftrunk\n" });
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));

    post(webview, { type: "acceptSide", side: "left" });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(fs.readFileSync(file, "utf8")).toBe("\ufefftrunk\n");
  });

  it("writes no second mark when the working copy kept it, as VS Code then saves it", async () => {
    divergeFile(repo, "f.txt", {
      base: "\ufeffline1\nshared\n",
      feature: "\ufeffline1\nmine\n",
      trunk: "\ufeffline1\ntheirs\n",
    });
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));

    post(webview, { type: "acceptSide", side: "left" });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(fs.readFileSync(file, "utf8")).toBe("\ufeffline1\ntheirs\n");
  });

  it("writes no mark to a file whose versions have none", async () => {
    divergeFile(repo, "f.txt", { base: "base\n", feature: "feature\n", trunk: "trunk\n" });
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));

    post(webview, { type: "acceptSide", side: "left" });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(fs.readFileSync(file, "utf8")).toBe("trunk\n");
  });

  it("writes the mark when it creates the file again after it was deleted", async () => {
    divergeFile(repo, "f.txt", { base: "\ufeffbase\n", feature: "\ufefffeature\n", trunk: "\ufefftrunk\n" });
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
    expect(fs.readFileSync(file, "utf8")).toBe("\ufefftrunk\n");
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
    expect(vscodeMock.messages[1].text).toBe("jw-differ could not complete the merge action. The file cannot be opened.");
  });
});

describe("MergeViewPanel while applying", () => {
  it("asks and writes once when Apply is clicked twice", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    vscodeMock.warningMessageResponse = () => "Apply";

    post(webview, { type: "apply" });
    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vscodeMock.messages.map(({ level }) => level)).toEqual(["warning"]);
    expect(vscodeMock.appliedEdits).toHaveLength(1);
  });

  it("drops an edit sent while Apply asks, and redraws the page when Apply is called off", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    const page = shownPage(webview);
    vscodeMock.warningMessageResponse = () => {
      post(webview, { type: "editLine", line: 0, text: "typed while asked" });
      return undefined;
    };

    post(webview, { type: "apply" });

    await vi.waitFor(() => expect(shownPage(webview)).not.toBe(page));
    expect(webview.html).not.toContain("typed while asked");
    vscodeMock.warningMessageResponse = () => "Apply";
    post(webview, { type: "apply" });
    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(fs.readFileSync(file, "utf8")).toBe("base\n");
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
    expect(html).toContain("jw-differ cannot merge f.txt");
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`);
  });

  it("says a version is not UTF-8 rather than that the file is not conflicted", async () => {
    const latin1 = (text: string): Buffer => Buffer.from(text, "latin1");
    divergeFile(repo, "f.txt", { base: latin1("\u00e9\n"), feature: latin1("\u00e9 mine\n"), trunk: latin1("\u00e9 trunk\n") });
    mergeFeature(repo);

    await openPanel(fileDocument(path.join(repo, "f.txt")));

    const { html } = vscodeMock.webviewPanels[0].webview;
    expect(html).toContain("jw-differ cannot merge f.txt");
    expect(html).toContain("is not UTF-8 text");
    expect(html).not.toContain("not conflicted");
  });

  it("says a version is binary rather than that the file is not conflicted", async () => {
    divergeFile(repo, "f.txt", { base: "text\n", feature: "bin\0ary\n", trunk: "trunk\n" });
    mergeFeature(repo);

    await openPanel(fileDocument(path.join(repo, "f.txt")));

    const { html } = vscodeMock.webviewPanels[0].webview;
    expect(html).toContain("jw-differ cannot merge f.txt");
    expect(html).toContain("is binary");
    expect(html).not.toContain("not conflicted");
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

  it("tells the redrawn page where the undone or redone step changed the result, for the caret", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));

    post(webview, { type: "editLine", line: 0, text: "based" });
    await postAndRedraw(webview, { type: "undo" });
    const pageAfterUndo = webview.html;
    await postAndRedraw(webview, { type: "redo" });

    expect(pageAfterUndo).toContain('data-caret-line="0" data-caret-column="4"');
    expect(webview.html).toContain('data-caret-line="0" data-caret-column="4"');
  });

  it("names no caret position when the step left the result as it was", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));

    post(webview, { type: "ignoreSide", chunk: 0, side: "right" });
    await vi.waitFor(() => expect(shownPage(webview)).toBe(2));
    await postAndRedraw(webview, { type: "undo" });

    expect(webview.html).not.toContain("data-caret");
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
  });

  it("replaces the page on a colour theme change only once the page sent the edit it held back", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));

    changeColorThemeKind(ColorThemeKind.Light);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pageWhileWaiting = shownPage(webview);
    post(webview, { type: "editLine", line: 0, text: "held back" });
    post(webview, { type: "redrawReady", caret: null });

    await vi.waitFor(() => expect(shownPage(webview)).toBe(2));
    expect(pageWhileWaiting).toBe(1);
    expect(/data-line="0">(.*?)<\/div>/.exec(webview.html)?.[1]).toContain(">held back<");
  });

  it("puts the caret on the page a colour theme change draws where the page it replaces had it", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));

    changeColorThemeKind(ColorThemeKind.Light);
    await new Promise((resolve) => setTimeout(resolve, 50));
    post(webview, { type: "redrawReady", caret: { line: 0, column: 4 } });

    await vi.waitFor(() => expect(shownPage(webview)).toBe(2));
    expect(webview.html).toContain('data-caret-line="0" data-caret-column="4"');
  });

  it("replaces a page that does not answer the colour theme change", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));

    changeColorThemeKind(ColorThemeKind.Light);

    await vi.waitFor(() => expect(shownPage(webview)).toBe(2), { timeout: 2_000 });
  });
});

/** Colours every line by the colour theme kind, as a grammar's theme does. */
const themedHighlighter: TextHighlighter = {
  highlight: async (text: string) => {
    const style = { color: vscodeMock.colorThemeKind === ColorThemeKind.Light ? "#111111" : "#eeeeee", fontStyle: 0 };
    return { styles: [style], lines: text.split("\n").map((line) => [{ length: line.length, styleIndex: 0 }]) };
  },
};

async function openThemedPanel(file: string): Promise<FakeWebview> {
  await createPanel(fileDocument(file), themedHighlighter);
  return vscodeMock.webviewPanels[0].webview;
}

/** Longer than the host waits for the page to answer a colour theme change. */
const pastHeldBackEditTimeout = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600));

describe("MergeViewPanel colour theme change while applying", () => {
  /** Holds Apply's confirmation open until the returned function answers it. */
  async function holdApplyConfirmation(): Promise<(answer: string | undefined) => void> {
    let answerConfirmation: ((answer: string | undefined) => void) | undefined;
    vscodeMock.warningMessageResponse = () => new Promise((resolve) => (answerConfirmation = resolve));
    await vi.waitFor(() => expect(answerConfirmation).toBeDefined());
    return answerConfirmation as (answer: string | undefined) => void;
  }

  it("does not redraw while Apply asks, and redraws with the new colours when Apply is called off", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openThemedPanel(path.join(repo, "f.txt"));
    const confirmation = holdApplyConfirmation();
    post(webview, { type: "apply" });
    const answerConfirmation = await confirmation;

    changeColorThemeKind(ColorThemeKind.Light);
    await pastHeldBackEditTimeout();

    expect(shownPage(webview)).toBe(1);
    expect(postedOfType(webview, "redrawing")).toEqual([]);
    answerConfirmation(undefined);
    await vi.waitFor(() => expect(shownPage(webview)).toBe(2));
    expect(webview.html).toContain(".tk-left-0{color:#111111}");
    expect(webview.html).not.toContain("#eeeeee");
  });

  it("does not redraw when Apply begins while the page is told of a colour theme change", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openThemedPanel(path.join(repo, "f.txt"));
    changeColorThemeKind(ColorThemeKind.Light);
    const confirmation = holdApplyConfirmation();
    post(webview, { type: "apply" });
    const answerConfirmation = await confirmation;

    post(webview, { type: "redrawReady", caret: null });
    await pastHeldBackEditTimeout();

    expect(shownPage(webview)).toBe(1);
    answerConfirmation(undefined);
    await vi.waitFor(() => expect(shownPage(webview)).toBe(2));
    await pastHeldBackEditTimeout();
    expect(shownPage(webview)).toBe(2);
    expect(webview.html).toContain(".tk-left-0{color:#111111}");
  });

  it("closes the panel when Apply goes ahead after a colour theme change", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openThemedPanel(file);
    const confirmation = holdApplyConfirmation();
    post(webview, { type: "apply" });
    const answerConfirmation = await confirmation;

    changeColorThemeKind(ColorThemeKind.Light);
    answerConfirmation("Apply");

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    await pastHeldBackEditTimeout();
    expect(vscodeMock.messages.map(({ level }) => level)).toEqual(["warning"]);
    expect(shownPage(webview)).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe("base\n");
  });
});

describe("MergeViewPanel waiting for the page to answer a colour theme change", () => {
  /** The waits for a page's answer the panel still holds; one that ended must not linger until a later answer. */
  function pendingWaits(panel: MergeViewPanel): number {
    return [...(panel as unknown as { heldBackEditWaiters: Iterable<unknown> }).heldBackEditWaiters].length;
  }

  it("forgets a wait once it ends, whether the page answered or not", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const panel = await createPanel(fileDocument(path.join(repo, "f.txt")));
    const { webview } = vscodeMock.webviewPanels[0];

    changeColorThemeKind(ColorThemeKind.Light);
    await vi.waitFor(() => expect(shownPage(webview)).toBe(2), { timeout: 2_000 });
    const waitsAfterTimeout = pendingWaits(panel);
    changeColorThemeKind(ColorThemeKind.Dark);
    post(webview, { type: "redrawReady", caret: null });
    await vi.waitFor(() => expect(shownPage(webview)).toBe(3));

    expect(waitsAfterTimeout).toBe(0);
    expect(pendingWaits(panel)).toBe(0);
  });

  it("keeps a page an action drew with the new colours while the replaced page was told of the change", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openThemedPanel(path.join(repo, "f.txt"));
    changeColorThemeKind(ColorThemeKind.Light);

    post(webview, { type: "ignoreSide", chunk: 0, side: "right" });
    await vi.waitFor(() => expect(shownPage(webview)).toBe(2));
    webview.fireDidReceiveMessage({ type: "redrawReady", caret: null, page: 1 });
    await pastHeldBackEditTimeout();

    expect(shownPage(webview)).toBe(2);
    expect(webview.html).toContain(".tk-left-0{color:#111111}");
  });

  it("tells a page an action drew with the old colours during the wait before replacing it", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openThemedPanel(path.join(repo, "f.txt"));
    post(webview, { type: "ignoreSide", chunk: 0, side: "right" });
    changeColorThemeKind(ColorThemeKind.Light);
    await vi.waitFor(() => expect(shownPage(webview)).toBe(2));
    webview.fireDidReceiveMessage({ type: "redrawReady", caret: null, page: 1 });

    await vi.waitFor(() => expect(postedOfType(webview, "redrawing")).toEqual([{ type: "redrawing", page: 1 }, { type: "redrawing", page: 2 }]));
    expect(shownPage(webview)).toBe(2);
    post(webview, { type: "redrawReady", caret: null });
    await vi.waitFor(() => expect(shownPage(webview)).toBe(3));
    expect(webview.html).toContain(".tk-left-0{color:#111111}");
  });

  it("keeps waiting when a replaced page answers late", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));
    changeColorThemeKind(ColorThemeKind.Light);
    await vi.waitFor(() => expect(shownPage(webview)).toBe(2), { timeout: 2_000 });

    changeColorThemeKind(ColorThemeKind.Dark);
    webview.fireDidReceiveMessage({ type: "redrawReady", caret: null, page: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(shownPage(webview)).toBe(2);
    post(webview, { type: "redrawReady", caret: null });
    await vi.waitFor(() => expect(shownPage(webview)).toBe(3));
  });
});

describe("MergeViewPanel driving its page", () => {
  const LINE_HEIGHT = 18;

  interface LayoutMessage {
    readonly type: "layout";
    readonly data: { readonly chunks: readonly { readonly isResolved: boolean }[] };
  }

  /**
   * Runs each page the panel draws in the page fixture, with a result pane two lines high, and carries the messages
   * both ways as the webview does. Records, for each page, the chunk resolutions it was drawn with and those of every
   * layout the panel sent it.
   */
  class ShownPages {
    readonly drawnResolutions: boolean[][] = [];
    readonly layoutResolutions: boolean[][][] = [];
    private page: MergePage | null = null;
    private html = "";
    private sentCount = 0;
    private receivedCount = 0;

    constructor(private readonly webview: FakeWebview) {
      this.exchange();
    }

    /** The page the panel drew last. */
    get shown(): MergePage {
      return this.page!;
    }

    /** Sends what the page posted, loads the page the panel drew last, and delivers what the panel posted to it. */
    exchange(): void {
      const posted = this.page?.posted.slice(this.sentCount) ?? [];
      this.sentCount += posted.length;
      posted.forEach((message) => this.webview.fireDidReceiveMessage(message));
      if (this.webview.html !== this.html) {
        this.load();
      }
      const received = this.webview.postedSinceHtml.slice(this.receivedCount) as Record<string, unknown>[];
      this.receivedCount += received.length;
      for (const message of received) {
        if (message.type === "layout") {
          this.layoutResolutions.at(-1)!.push((message as unknown as LayoutMessage).data.chunks.map((chunk) => chunk.isResolved));
        }
        this.shown.receive(message);
      }
    }

    async exchangeUntil(condition: () => void): Promise<void> {
      await vi.waitFor(() => {
        this.exchange();
        condition();
      });
    }

    /** Which of the ruler's marks is outlined as the change navigated to. */
    outline(): boolean[] {
      const marks = this.shown.document.getElementById("overview")!.childNodes[0] as FakeElement;
      return marks.childNodes.map((mark) => (mark as FakeElement).className.includes("is-current"));
    }

    private load(): void {
      this.html = this.webview.html;
      const page = new MergePage(this.html);
      this.page = page;
      this.sentCount = 0;
      this.receivedCount = 0;
      const data = JSON.parse(page.document.getElementById("merge")!.dataset.merge!) as LayoutMessage["data"];
      this.drawnResolutions.push(data.chunks.map((chunk) => chunk.isResolved));
      this.layoutResolutions.push([]);
      const result = page.document.getElementById("scroll-result")!;
      result.scrollHeight = result.querySelectorAll(".code[data-line]").length * LINE_HEIGHT;
      result.clientHeight = 2 * LINE_HEIGHT;
      page.document.getElementById("overview")!.clientHeight = 4 * LINE_HEIGHT;
      page.resize();
    }
  }

  function textOf(cell: FakeElement): FakeText {
    return cell.childNodes[0] as FakeText;
  }

  it("sends a page only layouts with the resolutions it was drawn with, keeping the outline on the change navigated to", async () => {
    // A conflict on line 2, a trunk change on line 5 and a feature change on line 8.
    divergeFile(repo, "f.txt", { base: "1\n2\n3\n4\n5\n6\n7\n8\n9\n", trunk: "1\nT\n3\n4\nT\n6\n7\n8\n9\n", feature: "1\nF\n3\n4\n5\n6\n7\nF\n9\n" });
    mergeFeature(repo);
    const pages = new ShownPages(await openPanel(fileDocument(path.join(repo, "f.txt"))));
    const page = pages.shown;
    page.key(page.resultCell(0), { key: "F7" });
    expect(pages.outline()).toEqual([false, true, false]);

    page.placeCaret(page.resultCell(0), 1);
    page.key(page.resultCell(0), { key: "Enter" });
    await pages.exchangeUntil(() => expect(pages.layoutResolutions[0]).toHaveLength(1));
    expect(pages.outline()).toEqual([false, true, false]);

    page.placeCaret(page.resultCell(1), 0);
    page.key(page.resultCell(1), { key: "Backspace" });
    await pages.exchangeUntil(() => expect(pages.layoutResolutions[0]).toHaveLength(2));
    expect(pages.outline()).toEqual([false, true, false]);

    // Typed over a selection from line 1 into the conflict's line 2.
    page.select(textOf(page.resultCell(0)), 0, textOf(page.resultCell(1)), 0);
    page.key(page.resultCell(0), { key: "x" });
    await pages.exchangeUntil(() => expect(pages.layoutResolutions[0]).toHaveLength(3));
    expect(pages.outline()).toEqual([false, true, false]);

    // The change navigated to is accepted before the layout answering a split arrives.
    page.placeCaret(page.resultCell(0), page.resultCell(0).textContent.length);
    page.key(page.resultCell(0), { key: "Enter" });
    page.click(page.button((button) => button.classList.contains("act") && button.dataset.chunk === "1" && button.dataset.action === "apply"));
    await pages.exchangeUntil(() => expect(pages.drawnResolutions).toHaveLength(2));
    expect(pages.layoutResolutions[0]).toHaveLength(4);
    expect(pages.outline()).toEqual([true, false]);

    pages.shown.key(pages.shown.resultCell(0), { key: "z", keyCode: 90, ctrlKey: true });
    await pages.exchangeUntil(() => expect(pages.drawnResolutions).toHaveLength(3));
    expect(pages.outline()).toEqual([true, false, false]);
    pages.shown.key(pages.shown.resultCell(0), { key: "Z", keyCode: 90, ctrlKey: true, shiftKey: true });
    await pages.exchangeUntil(() => expect(pages.drawnResolutions).toHaveLength(4));
    pages.shown.click(pages.shown.button((button) => button.dataset.accept === "left"));
    await pages.exchangeUntil(() => expect(pages.drawnResolutions).toHaveLength(5));

    expect(pages.drawnResolutions).toEqual([[false, false, false], [false, true, false], [false, false, false], [false, true, false], [true, true, true]]);
    pages.layoutResolutions.forEach((layouts, index) => layouts.forEach((resolutions) => expect(resolutions).toEqual(pages.drawnResolutions[index])));
  });
});
