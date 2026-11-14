import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { listUnmergedEntries } from "../git/gitConflictedFiles";
import { unstyledText } from "../highlight/textMateHighlighter";
import { MergeViewPanel } from "../host/vscode/mergeViewPanel";
import type { TextHighlighter } from "../host/vscode/twoWayDiffPanel";
import { createConflictRepository, divergeBranches, mergeFeature, runGit } from "./gitConflictFixture";
import { type FakeWebview, fireDidCloseTextDocument, resetVscodeMock, vscodeMock } from "./vscodeMock";

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

    webview.fireDidReceiveMessage({ type: "acceptSide", side: "left" });
    webview.fireDidReceiveMessage({ type: "apply" });

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

    webview.fireDidReceiveMessage({ type: "acceptSide", side: "left" });
    webview.fireDidReceiveMessage({ type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(vscodeMock.messages).toEqual([]);
    expect(vscodeMock.appliedEdits.at(-1)?.range.end.line).toBe(lastLine);
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

    webview.fireDidReceiveMessage({ type: "apply" });

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

    webview.fireDidReceiveMessage({ type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(vscodeMock.messages.map(({ level }) => level)).toEqual(["warning"]);
    expect(fs.readFileSync(file, "utf8")).toBe(vscodeMock.appliedEdits.at(-1)?.text);
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
  ])("redraws the page for %s", async (_label, message) => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const webview = await openPanel(fileDocument(path.join(repo, "f.txt")));
    const page = webview.html;

    webview.fireDidReceiveMessage(message);

    await vi.waitFor(() => expect(webview.html).not.toBe(page));
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

    webview.fireDidReceiveMessage({ type: "editLine", line: 0, text: "typed" });
    webview.fireDidReceiveMessage({ type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(webview.html).toBe(page);
    expect(fs.readFileSync(file, "utf8")).toBe("typed\n");
  });

  it("shows an edit made while a resolved chunk is being drawn", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    let webview: FakeWebview | undefined;
    let isTypingDuringRender = false;
    const typingHighlighter: TextHighlighter = {
      highlight: async (text: string) => {
        if (isTypingDuringRender) {
          isTypingDuringRender = false;
          webview?.fireDidReceiveMessage({ type: "editLine", line: 0, text: "typed meanwhile" });
        }
        return unstyledText(text);
      },
    };
    await createPanel(fileDocument(path.join(repo, "f.txt")), typingHighlighter);
    webview = vscodeMock.webviewPanels[0].webview;
    const page = webview.html;
    isTypingDuringRender = true;

    webview.fireDidReceiveMessage({ type: "ignoreSide", chunk: 0, side: "right" });

    await vi.waitFor(() => expect(webview?.html).not.toBe(page));
    await vi.waitFor(() => expect(webview?.html).toContain("typed meanwhile"));
  });
});

describe("MergeViewPanel splitting and joining result lines", () => {
  it("keeps the page and answers each edit with the chunk layout it left", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    const page = webview.html;

    webview.fireDidReceiveMessage({ type: "splitLine", line: 0, offset: 2, seq: 1 });
    webview.fireDidReceiveMessage({ type: "splitLine", line: 1, offset: 1, seq: 2 });
    webview.fireDidReceiveMessage({ type: "joinWithPrevious", line: 2, seq: 3 });

    await vi.waitFor(() => expect(webview.postedMessages).toHaveLength(3));
    expect(webview.html).toBe(page);
    expect(webview.postedMessages[0]).toMatchObject({ type: "layout", seq: 1, data: { resultLineCount: 3, chunks: [{ result: [0, 2] }] } });
    expect(webview.postedMessages[2]).toMatchObject({ type: "layout", seq: 3, data: { resultLineCount: 3, chunks: [{ result: [0, 2] }] } });
  });

  it("applies the split and joined lines", async () => {
    divergeBranches(repo, ["f.txt"]);
    mergeFeature(repo);
    const file = path.join(repo, "f.txt");
    const webview = await openPanel(fileDocument(file));
    vscodeMock.warningMessageResponse = () => "Apply";

    webview.fireDidReceiveMessage({ type: "splitLine", line: 0, offset: 2, seq: 1 });
    webview.fireDidReceiveMessage({ type: "splitLine", line: 1, offset: 1, seq: 2 });
    webview.fireDidReceiveMessage({ type: "joinWithPrevious", line: 1, seq: 3 });
    webview.fireDidReceiveMessage({ type: "apply" });

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[0].isDisposed).toBe(true));
    expect(fs.readFileSync(file, "utf8")).toBe("bas\ne\n");
  });
});
