import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { listUnmergedEntries } from "../git/gitConflictedFiles";
import { unstyledText } from "../highlight/textMateHighlighter";
import { MergeViewPanel } from "../host/vscode/mergeViewPanel";
import { createConflictRepository, divergeBranches, mergeFeature, runGit } from "./gitConflictFixture";
import { type FakeWebview, resetVscodeMock, vscodeMock } from "./vscodeMock";

let repo: string;
let outside: string;

/** A file document whose save writes the last applied edit to disk, following symbolic links as the editor's save does. */
function fileDocument(filePath: string): vscode.TextDocument {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  const save = async (): Promise<boolean> => {
    fs.writeFileSync(filePath, vscodeMock.appliedEdits.at(-1)?.text ?? text);
    return true;
  };
  return {
    uri: vscode.Uri.file(filePath),
    languageId: "plaintext",
    eol: vscode.EndOfLine.LF,
    lineCount: lines.length,
    getText: () => text,
    lineAt: (line: number) => ({ range: new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, lines[line].length)) }),
    save,
  } as unknown as vscode.TextDocument;
}

async function openPanel(document: vscode.TextDocument): Promise<FakeWebview> {
  await MergeViewPanel.create({
    document,
    mediaRoot: vscode.Uri.file(os.tmpdir()),
    highlighter: { highlight: async (text: string) => unstyledText(text) },
    log: () => undefined,
    onDispose: () => undefined,
  });
  return vscodeMock.webviewPanels[0].webview;
}

beforeEach(() => {
  resetVscodeMock();
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
  });
});
