import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { activate, deactivate } from "../host/vscode/extension";
import type { HistoryDiffProvider } from "../host/vscode/historyDiffProvider";
import type { ComparisonFile, HistoryRepository, ReadyResult } from "../model/historyTypes";
import { resetVscodeMock, vscodeMock } from "./vscodeMock";

interface ConfigurationProperty {
  readonly type?: string;
  readonly enum?: readonly string[];
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

interface Manifest {
  readonly activationEvents: readonly string[];
  readonly contributes: {
    readonly commands: readonly { readonly command: string; readonly icon?: string | { readonly light: string; readonly dark: string } }[];
    readonly viewsContainers: Readonly<Record<string, readonly { readonly id: string; readonly icon: string }[]>>;
    readonly views: Readonly<Record<string, readonly { readonly id: string; readonly type?: string }[]>>;
    readonly viewsWelcome?: readonly { readonly view: string; readonly contents: string }[];
    readonly menus: Readonly<Record<string, readonly { readonly command: string; readonly when?: string; readonly group?: string }[]>>;
    readonly configuration: { readonly properties: Readonly<Record<string, ConfigurationProperty>> };
  };
}

const EXTENSION_ROOT = path.join(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, "package.json"), "utf8")) as Manifest;

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

  it("opens history through the contributed view's focus command and leaves the side bar alone", async () => {
    activateExtension();
    vscodeMock.executedCommands.length = 0;

    await vscode.commands.executeCommand("jwDiffer.openHistory");

    // Context keys set meanwhile, such as the conflicted files found on activation, are not commands opening ran.
    const openingCommands = vscodeMock.executedCommands.map((executed) => executed.command).filter((command) => command !== "setContext");
    expect(openingCommands).toEqual(["jwDiffer.openHistory", "jwDiffer.history.focus"]);
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
    const { commands, viewsContainers, views, viewsWelcome, menus } = manifest.contributes;

    expect(commands.map((entry) => entry.command).sort()).toEqual([...vscodeMock.commands.keys()].sort());
    expect(viewsContainers).toEqual({ panel: [{ id: "jwDifferHistory", title: "jw-differ", icon: "$(git-commit)" }] });
    expect(views).toEqual({ jwDifferHistory: [{ type: "webview", id: "jwDiffer.history", name: "Git History" }] });
    expect(viewsWelcome).toBeUndefined();
    expect(menus["view/title"]).toEqual([
      { command: "jwDiffer.refreshHistory", when: "view == jwDiffer.history", group: "navigation" },
      { command: "jwDiffer.openHistory", when: "view == workbench.explorer.fileView", group: "navigation@50" },
    ]);
    expect(menus["scm/title"]).toEqual([{ command: "jwDiffer.openHistory", when: "scmProvider == git", group: "navigation@50" }]);
    const paletteHistory = menus.commandPalette.filter((entry) => entry.command.endsWith("History"));
    expect(paletteHistory).toEqual([{ command: "jwDiffer.openHistory" }, { command: "jwDiffer.refreshHistory" }]);
    expect(menus["editor/title"]).toEqual([
      { command: "jwDiffer.openMergeView", when: "jwDiffer.hasConflicts", group: "navigation" },
    ]);
    expect(manifest.activationEvents).toContain("onStartupFinished");
  });

  it("draws the header buttons with jw-differ's glyph in fixed light and dark theme colours", () => {
    const openHistory = manifest.contributes.commands.find((entry) => entry.command === "jwDiffer.openHistory");

    const glyphPaths = { light: "media/differ-history-light.svg", dark: "media/differ-history-dark.svg" };

    // Menus draw file icons as background images, where an SVG's currentColor does not follow the theme.
    expect(openHistory?.icon).toEqual(glyphPaths);
    for (const glyphPath of Object.values(glyphPaths)) {
      expect(fs.readFileSync(path.join(EXTENSION_ROOT, glyphPath), "utf8")).not.toContain("currentColor");
    }
  });

  it("contributes the history diff viewer setting with the IntelliJ view as default", () => {
    const viewer = manifest.contributes.configuration.properties["jwDiffer.historyDiffViewer"];

    expect(viewer.enum).toEqual(["intellij", "native"]);
    expect(viewer.default).toBe("intellij");
  });

  it("contributes the history commit cap setting: 20,000 by default, at least 100, no maximum", () => {
    const cap = manifest.contributes.configuration.properties["jwDiffer.historyMaxCommits"];

    expect(cap).toMatchObject({ type: "number", default: 20_000, minimum: 100 });
    expect(cap?.maximum).toBeUndefined();
    expect(cap?.description).toMatch(/use more of the extension host.s memory/);
  });

  it("opens history text files in a diff panel, unstyled without a grammar, and closes it on disposal", async () => {
    const subscriptions = activateExtension();
    const provider = vscodeMock.contentProviders.get("jw-differ-history") as HistoryDiffProvider;
    const repository = {
      readFile: (_snapshotId: string, _fileId: string, side: string) => Promise.resolve({ kind: "text", text: `${side}\n` }),
    } as unknown as HistoryRepository;
    const comparison = { kind: "ready", snapshotId: "s", base: { kind: "emptyTree" }, orderedOids: ["d".repeat(40)], files: [] } as unknown as ReadyResult;
    const file = { id: "f", status: "modified", base: { path: "a.ts" }, result: { path: "a.ts" }, contentKind: "text" } as unknown as ComparisonFile;

    await provider.openFile({ repository, root: "/work/project" }, comparison, file);

    const [panel] = vscodeMock.webviewPanels;
    expect(panel.title).toBe("a.ts (empty tree ↔ 1 selected commit)");
    expect(panel.webview.html).toContain("result");

    await deactivate();
    subscriptions.forEach((subscription) => subscription.dispose());

    expect(panel.isDisposed).toBe(true);
  });
});
