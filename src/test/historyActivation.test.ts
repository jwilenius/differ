import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { activate, deactivate } from "../host/vscode/extension";
import type { HistoryDiffProvider } from "../host/vscode/historyDiffProvider";
import type { ComparisonFile, HistoryRepository, ReadyResult } from "../model/historyTypes";
import { resetVscodeMock, vscodeMock } from "./vscodeMock";

interface Manifest {
  readonly activationEvents: readonly string[];
  readonly contributes: {
    readonly commands: readonly { readonly command: string }[];
    readonly viewsContainers: Readonly<Record<"activitybar" | "panel", readonly { readonly id: string; readonly icon: string }[]>>;
    readonly views: Readonly<Record<string, readonly { readonly id: string; readonly type?: string }[]>>;
    readonly viewsWelcome: readonly { readonly view: string; readonly contents: string }[];
    readonly menus: Readonly<Record<string, readonly { readonly command: string; readonly when?: string }[]>>;
    readonly configuration: { readonly properties: Readonly<Record<string, { readonly enum?: readonly string[]; readonly default?: unknown }>> };
  };
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as Manifest;

/** An extension folder holding only the bundled regex engine, as the build lays it out. */
function extensionFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jw-differ-extension-"));
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

    expect([...vscodeMock.webviewViewProviders.keys()]).toEqual(["jwDiffer.history"]);
    expect(vscodeMock.treeViews.map((view) => view.viewId)).toEqual(["jwDiffer.launcher"]);
    expect([...vscodeMock.contentProviders.keys()]).toEqual(["jw-differ-history"]);
    expect([...vscodeMock.commands.keys()].sort()).toEqual([
      "jwDiffer.openHistory",
      "jwDiffer.openMergeView",
      "jwDiffer.refreshHistory",
      "jwDiffer.resolveConflictInFile",
      "jwDiffer.resolveConflicts",
    ]);
    expect(vscodeMock.outputChannels.map((channel) => channel.name)).toEqual(["jw-differ History"]);
  });

  it("opens history through the contributed view's focus command", async () => {
    activateExtension();

    await vscode.commands.executeCommand("jwDiffer.openHistory");

    expect(vscodeMock.executedCommands.map((executed) => executed.command)).toContain("jwDiffer.history.focus");
  });

  it("opens the history panel and closes the side bar on the Explorer when the Activity Bar icon shows the launcher", async () => {
    activateExtension();
    const [launcher] = vscodeMock.treeViews;
    vscodeMock.executedCommands.length = 0;

    // Context keys set meanwhile, such as the conflicted files found on activation, are not commands the launcher ran.
    const launcherCommands = (): string[] =>
      vscodeMock.executedCommands.map((executed) => executed.command).filter((command) => command !== "setContext");
    launcher.fireDidChangeVisibility(true);
    await vi.waitFor(() => expect(launcherCommands()).toHaveLength(3));

    expect(launcherCommands()).toEqual([
      "workbench.view.explorer",
      "workbench.action.closeSidebar",
      "jwDiffer.history.focus",
    ]);
  });

  it("leaves the side bar alone on activation and when the launcher hides", async () => {
    activateExtension();
    const [launcher] = vscodeMock.treeViews;

    launcher.fireDidChangeVisibility(false);

    const commands = vscodeMock.executedCommands.map((executed) => executed.command);
    expect(commands).not.toContain("workbench.view.explorer");
    expect(commands).not.toContain("workbench.action.closeSidebar");
  });

  it("removes every registration and owned UI item on deactivation and disposal", async () => {
    const subscriptions = activateExtension();

    await deactivate();
    expect(vscodeMock.statusBarItems.every((item) => item.isDisposed)).toBe(true);
    subscriptions.forEach((subscription) => subscription.dispose());

    expect(vscodeMock.commands.size).toBe(0);
    expect(vscodeMock.webviewViewProviders.size).toBe(0);
    expect(vscodeMock.treeViews.every((view) => view.isDisposed)).toBe(true);
    expect(vscodeMock.contentProviders.size).toBe(0);
    expect(vscodeMock.outputChannels.every((channel) => channel.isDisposed)).toBe(true);
    expect(vscodeMock.statusBarItems.every((item) => item.isDisposed)).toBe(true);
  });

  it("contributes exactly the registered view and commands", () => {
    activateExtension();
    const { commands, viewsContainers, views, menus } = manifest.contributes;

    expect(commands.map((entry) => entry.command).sort()).toEqual([...vscodeMock.commands.keys()].sort());
    expect(viewsContainers.panel).toEqual([{ id: "jwDifferHistory", title: "jw-differ", icon: "$(git-commit)" }]);
    expect(views.jwDifferHistory).toEqual([{ type: "webview", id: "jwDiffer.history", name: "Git History" }]);
    expect(viewsContainers.activitybar).toEqual([{ id: "jwDifferLauncher", title: "jw-differ", icon: "media/differ-activitybar.svg" }]);
    expect(views.jwDifferLauncher.map((view) => view.id)).toEqual(vscodeMock.treeViews.map((view) => view.viewId));
    expect(fs.existsSync(path.join(__dirname, "..", "..", viewsContainers.activitybar[0].icon))).toBe(true);
    expect(menus["view/title"]).toEqual([
      { command: "jwDiffer.refreshHistory", when: "view == jwDiffer.history", group: "navigation" },
    ]);
    const paletteHistory = menus.commandPalette.filter((entry) => entry.command.endsWith("History"));
    expect(paletteHistory).toEqual([{ command: "jwDiffer.openHistory" }, { command: "jwDiffer.refreshHistory" }]);
    expect(menus["editor/title"]).toEqual([
      { command: "jwDiffer.openMergeView", when: "jwDiffer.hasConflicts", group: "navigation" },
    ]);
    expect(manifest.activationEvents).toContain("onStartupFinished");
  });

  it("offers an Open Git History link in the launcher in case it stays open", () => {
    const [welcome] = manifest.contributes.viewsWelcome;

    expect(manifest.contributes.viewsWelcome).toHaveLength(1);
    expect(welcome.view).toBe("jwDiffer.launcher");
    expect(welcome.contents).toContain("(command:jwDiffer.openHistory)");
  });

  it("contributes the history diff viewer setting with the IntelliJ view as default", () => {
    const viewer = manifest.contributes.configuration.properties["jwDiffer.historyDiffViewer"];

    expect(viewer.enum).toEqual(["intellij", "native"]);
    expect(viewer.default).toBe("intellij");
  });

  it("opens history text files in a diff panel, unstyled without a grammar, and closes it on disposal", async () => {
    const subscriptions = activateExtension();
    const provider = vscodeMock.contentProviders.get("jw-differ-history") as HistoryDiffProvider;
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
