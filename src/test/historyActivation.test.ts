import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { activate, deactivate } from "../host/vscode/extension";
import type { HistoryDiffProvider } from "../host/vscode/historyDiffProvider";
import type { ComparisonFile, HistoryRepository, ReadyResult } from "../model/historyTypes";
import { resetVscodeMock, vscodeMock } from "./vscodeMock";

interface Manifest {
  readonly activationEvents: readonly string[];
  readonly contributes: {
    readonly commands: readonly { readonly command: string }[];
    readonly viewsContainers: { readonly panel: readonly { readonly id: string; readonly icon: string }[] };
    readonly views: Readonly<Record<string, readonly { readonly id: string; readonly type: string }[]>>;
    readonly menus: Readonly<Record<string, readonly { readonly command: string; readonly when?: string }[]>>;
    readonly configuration: { readonly properties: Readonly<Record<string, { readonly enum?: readonly string[]; readonly default?: unknown }>> };
  };
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as Manifest;

/** An extension folder holding only the bundled regex engine, as the build lays it out. */
function extensionFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "differ-extension-"));
  fs.mkdirSync(path.join(folder, "dist"));
  fs.copyFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"), path.join(folder, "dist", "onig.wasm"));
  return folder;
}

const EXTENSION_PATH = extensionFolder();

function activateExtension(): vscode.Disposable[] {
  const subscriptions: vscode.Disposable[] = [];
  const context = { subscriptions, extensionUri: vscode.Uri.file(EXTENSION_PATH), extensionPath: EXTENSION_PATH };
  activate(context as unknown as vscode.ExtensionContext);
  return subscriptions;
}

describe("extension activation", () => {
  beforeEach(() => resetVscodeMock());
  afterAll(() => fs.rmSync(EXTENSION_PATH, { recursive: true, force: true }));

  it("registers the history view, document provider and commands next to merge opening", () => {
    activateExtension();

    expect([...vscodeMock.webviewViewProviders.keys()]).toEqual(["differ.history"]);
    expect([...vscodeMock.contentProviders.keys()]).toEqual(["differ-history"]);
    expect([...vscodeMock.commands.keys()].sort()).toEqual([
      "differ.openHistory",
      "differ.openMergeView",
      "differ.refreshHistory",
    ]);
    expect(vscodeMock.outputChannels.map((channel) => channel.name)).toEqual(["Differ History"]);
  });

  it("opens history through the contributed view's focus command", async () => {
    activateExtension();

    await vscode.commands.executeCommand("differ.openHistory");

    expect(vscodeMock.executedCommands.map((executed) => executed.command)).toContain("differ.history.focus");
  });

  it("removes every registration and owned UI item on deactivation and disposal", async () => {
    const subscriptions = activateExtension();

    await deactivate();
    expect(vscodeMock.statusBarItems.every((item) => item.isDisposed)).toBe(true);
    subscriptions.forEach((subscription) => subscription.dispose());

    expect(vscodeMock.commands.size).toBe(0);
    expect(vscodeMock.webviewViewProviders.size).toBe(0);
    expect(vscodeMock.contentProviders.size).toBe(0);
    expect(vscodeMock.outputChannels.every((channel) => channel.isDisposed)).toBe(true);
    expect(vscodeMock.statusBarItems.every((item) => item.isDisposed)).toBe(true);
  });

  it("contributes exactly the registered view and commands", () => {
    activateExtension();
    const { commands, viewsContainers, views, menus } = manifest.contributes;

    expect(commands.map((entry) => entry.command).sort()).toEqual([...vscodeMock.commands.keys()].sort());
    expect(viewsContainers.panel).toEqual([{ id: "differHistory", title: "Differ", icon: "$(git-commit)" }]);
    expect(views.differHistory).toEqual([{ type: "webview", id: "differ.history", name: "Git History" }]);
    expect(menus["view/title"]).toEqual([
      { command: "differ.refreshHistory", when: "view == differ.history", group: "navigation" },
    ]);
    const paletteHistory = menus.commandPalette.filter((entry) => entry.command.endsWith("History"));
    expect(paletteHistory).toEqual([{ command: "differ.openHistory" }, { command: "differ.refreshHistory" }]);
    expect(menus["editor/title"]).toEqual([
      { command: "differ.openMergeView", when: "differ.hasConflicts", group: "navigation" },
    ]);
    expect(manifest.activationEvents).toContain("onStartupFinished");
  });

  it("contributes the history diff viewer setting with the IntelliJ view as default", () => {
    const viewer = manifest.contributes.configuration.properties["differ.historyDiffViewer"];

    expect(viewer.enum).toEqual(["intellij", "native"]);
    expect(viewer.default).toBe("intellij");
  });

  it("opens history text files in a diff panel, unstyled without a grammar, and closes it on disposal", async () => {
    const subscriptions = activateExtension();
    const provider = vscodeMock.contentProviders.get("differ-history") as HistoryDiffProvider;
    const repository = {
      readFile: (_snapshotId: string, _fileId: string, side: string) => Promise.resolve({ kind: "text", text: `${side}\n` }),
    } as unknown as HistoryRepository;
    const comparison = { kind: "ready", snapshotId: "s", base: { kind: "emptyTree" }, orderedOids: ["d".repeat(40)], files: [] } as unknown as ReadyResult;
    const file = { id: "f", status: "modified", base: { path: "a.ts" }, result: { path: "a.ts" }, contentKind: "text" } as unknown as ComparisonFile;

    await provider.openFile(repository, comparison, file);

    const [panel] = vscodeMock.webviewPanels;
    expect(panel.title).toBe("a.ts (empty tree ↔ 1 selected commit)");
    expect(panel.webview.html).toContain("result");

    await deactivate();
    subscriptions.forEach((subscription) => subscription.dispose());

    expect(panel.isDisposed).toBe(true);
  });
});
