import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { activate, deactivate } from "../host/vscode/extension";
import { resetVscodeMock, vscodeMock } from "./vscodeMock";

/** A pending read of git's merge stages that the test settles. */
interface StageRead {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** Each read of git's merge stages waits for the next queued promise and fails when it rejects. */
const stageReads = vi.hoisted(() => [] as Promise<void>[]);

vi.mock("../git/gitMergeSources", () => ({
  readMergeSources: async (_filePath: string, result: string) => {
    await stageReads.shift();
    return { ours: "ours\n", theirs: "theirs\n", base: "base\n", result, ourLabel: "trunk", theirLabel: "feature", isSidesSwapped: false };
  },
}));

const conflictedDocument = {
  uri: vscode.Uri.file("/work/f.txt"),
  languageId: "plaintext",
  eol: vscode.EndOfLine.LF,
  getText: () => "<<<<<<< trunk\nours\n=======\ntheirs\n>>>>>>> feature\n",
} as unknown as vscode.TextDocument;

function queueStageRead(): StageRead {
  let settle: StageRead = { resolve: () => undefined, reject: () => undefined };
  stageReads.push(new Promise<void>((resolve, reject) => (settle = { resolve, reject })));
  return settle;
}

/** Runs Differ: Open Merge View on the conflicted document, as its editor title button does. */
function openActiveMergeView(): void {
  vscodeMock.activeTextEditor = { document: conflictedDocument } as vscode.TextEditor;
  void vscode.commands.executeCommand("differ.openMergeView");
}

beforeEach(() => {
  resetVscodeMock();
  stageReads.length = 0;
  const folder = os.tmpdir();
  activate({ subscriptions: [], extensionUri: vscode.Uri.file(folder), extensionPath: folder } as unknown as vscode.ExtensionContext);
});

afterEach(async () => {
  await deactivate();
});

describe("Differ: Open Merge View", () => {
  it("keeps a newer merge view when an earlier one, closed while loading, then fails", async () => {
    const firstRead = queueStageRead();
    openActiveMergeView();
    vscodeMock.webviewPanels[0].dispose();
    queueStageRead().resolve();
    openActiveMergeView();
    await vi.waitFor(() => expect(vscodeMock.webviewPanels[1].webview.html).not.toBe(""));
    firstRead.reject(new Error("git failed"));
    await vi.waitFor(() => expect(vscodeMock.messages).toHaveLength(1));

    openActiveMergeView();

    await vi.waitFor(() => expect(vscodeMock.webviewPanels[1].revealCount).toBe(1));
    expect(vscodeMock.webviewPanels).toHaveLength(2);
  });

  it("reports a failed open once, without an unhandled rejection, when it was opened again meanwhile", async () => {
    const unhandledReasons: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => void unhandledReasons.push(reason);
    process.on("unhandledRejection", recordUnhandled);
    try {
      const read = queueStageRead();
      openActiveMergeView();
      openActiveMergeView();
      read.reject(new Error("git failed"));
      await vi.waitFor(() => expect(vscodeMock.messages).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }

    expect(unhandledReasons).toEqual([]);
    expect(vscodeMock.messages).toEqual([{ level: "error", text: "Differ could not open the merge view." }]);
    expect(vscodeMock.webviewPanels).toHaveLength(1);
  });
});
