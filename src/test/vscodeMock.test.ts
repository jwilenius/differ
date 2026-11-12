import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  changeWorkspaceFolders,
  createFakeWebviewView,
  EventEmitter,
  fireDidCloseTextDocument,
  resetVscodeMock,
  Uri,
  vscodeMock,
} from "./vscodeMock";

describe("vscode test alias", () => {
  beforeEach(() => resetVscodeMock());

  it("resolves the vscode module to the shared mock", () => {
    expect(vscode.Uri).toBe(Uri);
  });

  it("calls registered command handlers until the registration is disposed", async () => {
    const handler = vi.fn(() => "result");
    const registration = vscode.commands.registerCommand("differ.test", handler);

    const result = await vscode.commands.executeCommand("differ.test", 1, "two");
    registration.dispose();
    const afterDispose = await vscode.commands.executeCommand("differ.test");

    expect(result).toBe("result");
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(1, "two");
    expect(afterDispose).toBeUndefined();
    expect(vscodeMock.executedCommands).toEqual([
      { command: "differ.test", args: [1, "two"] },
      { command: "differ.test", args: [] },
    ]);
  });

  it("removes content and webview view providers on disposal", () => {
    const contentRegistration = vscode.workspace.registerTextDocumentContentProvider("differ-history", {
      provideTextDocumentContent: () => "",
    });
    const viewRegistration = vscode.window.registerWebviewViewProvider("differ.history", {
      resolveWebviewView: () => undefined,
    });
    expect(vscodeMock.contentProviders.has("differ-history")).toBe(true);
    expect(vscodeMock.webviewViewProviders.has("differ.history")).toBe(true);

    contentRegistration.dispose();
    viewRegistration.dispose();

    expect(vscodeMock.contentProviders.size).toBe(0);
    expect(vscodeMock.webviewViewProviders.size).toBe(0);
  });

  it("delivers no events to disposed listeners", () => {
    const emitter = new EventEmitter<number>();
    const kept = vi.fn();
    const removed = vi.fn();
    emitter.event(kept);
    emitter.event(removed).dispose();

    emitter.fire(7);

    expect(kept).toHaveBeenCalledWith(7);
    expect(removed).not.toHaveBeenCalled();
  });

  it("fires document close events to current subscribers only", () => {
    const listener = vi.fn();
    const subscription = vscode.workspace.onDidCloseTextDocument(listener);
    const document = { uri: Uri.parse("differ-history:/a") } as vscode.TextDocument;

    fireDidCloseTextDocument(document);
    subscription.dispose();
    fireDidCloseTextDocument(document);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(document);
  });

  it("reports workspace folder changes with the added and removed folders", () => {
    const listener = vi.fn();
    const first = { uri: Uri.file("/work/a"), name: "a", index: 0 };
    const second = { uri: Uri.file("/work/b"), name: "b", index: 1 };
    vscodeMock.workspaceFolders = [first];
    vscode.workspace.onDidChangeWorkspaceFolders(listener);

    changeWorkspaceFolders([second]);

    expect(vscode.workspace.workspaceFolders).toEqual([second]);
    expect(listener).toHaveBeenCalledWith({ added: [second], removed: [first] });
  });

  it.each([
    ["unicode", "/src/ünï cødé/文件.ts", "id=ü&side=left"],
    ["spaces and newlines", "/dir with space/line\nbreak.txt", "a b\nc"],
    ["query and fragment characters", "/a?b#c%d/../e", "x=1&y=?#%"],
  ])("round-trips %s through URI strings", (_label, uriPath, query) => {
    const uri = Uri.from({ scheme: "differ-history", path: uriPath, query });

    const parsed = Uri.parse(uri.toString());

    expect(parsed.toJSON()).toEqual(uri.toJSON());
  });

  it("joins paths and exposes file system paths", () => {
    const root = Uri.file("/repo");

    const media = Uri.joinPath(root, "media", "history.js");

    expect(media.scheme).toBe("file");
    expect(media.fsPath).toBe("/repo/media/history.js");
    expect(media.with({ scheme: "other" }).toString()).toBe("other:/repo/media/history.js");
  });

  it("records UI items, messages and folder-picker requests", async () => {
    vscodeMock.openDialogResponse = [Uri.file("/repo")];

    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    item.text = "Differ";
    item.show();
    vscode.window.createOutputChannel("Differ History").appendLine("failure");
    await vscode.window.showErrorMessage("Oops");
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true });

    expect(vscodeMock.statusBarItems[0]).toMatchObject({ text: "Differ", isVisible: true, priority: 10 });
    expect(vscodeMock.outputChannels[0]).toMatchObject({ name: "Differ History", lines: ["failure"] });
    expect(vscodeMock.messages).toEqual([{ level: "error", text: "Oops" }]);
    expect(vscodeMock.openDialogRequests).toEqual([{ canSelectFolders: true }]);
    expect(picked?.[0]?.fsPath).toBe("/repo");
  });

  it("lets tests drive a fake webview view", async () => {
    const view = createFakeWebviewView();
    const received = vi.fn();
    const disposed = vi.fn();
    const visibility = vi.fn();
    view.webview.onDidReceiveMessage(received);
    view.onDidDispose(disposed);
    view.onDidChangeVisibility(() => visibility(view.visible));

    await view.webview.postMessage({ type: "state" });
    view.webview.fireDidReceiveMessage({ type: "ready" });
    view.fireDidChangeVisibility(false);
    view.fireDidDispose();

    expect(view.webview.postedMessages).toEqual([{ type: "state" }]);
    expect(received).toHaveBeenCalledWith({ type: "ready" });
    expect(visibility).toHaveBeenCalledWith(false);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("clears recorded state and subscriptions on reset", () => {
    const listener = vi.fn();
    vscode.workspace.onDidCloseTextDocument(listener);
    vscode.commands.registerCommand("differ.test", () => undefined);
    vscodeMock.workspaceFolders = [];

    resetVscodeMock();
    fireDidCloseTextDocument({} as vscode.TextDocument);

    expect(listener).not.toHaveBeenCalled();
    expect(vscodeMock.commands.size).toBe(0);
    expect(vscode.workspace.workspaceFolders).toBeUndefined();
  });
});
