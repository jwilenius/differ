import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConflictedFilesContext } from "../host/vscode/conflictedFilesContext";
import { activate, deactivate } from "../host/vscode/extension";
import { createConflictRepository, divergeBranches, mergeFeature, runGit } from "./gitConflictFixture";
import { changeWindowFocus, changeWorkspaceFolders, resetVscodeMock, vscodeMock } from "./vscodeMock";

interface MenuEntry {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
}

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { readonly command: string; readonly title: string; readonly category: string }[];
    readonly menus: Readonly<Record<string, readonly MenuEntry[]>>;
  };
}

const COMMAND = "differ.resolveConflictInFile";
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as Manifest;

let repo: string;
let links: string;

function workspaceFolder(folder: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(folder), name: path.basename(folder), index: 0 };
}

/** A file document of the working copy, enough for the merge view to show it. */
function fileDocument(uri: vscode.Uri): vscode.TextDocument {
  const text = fs.readFileSync(uri.fsPath, "utf8");
  return { uri, languageId: "plaintext", eol: vscode.EndOfLine.LF, isClosed: false, getText: () => text } as unknown as vscode.TextDocument;
}

/** Activates with an extension folder that has no regex engine; nothing is highlighted. */
function activateExtension(): void {
  const folder = os.tmpdir();
  activate({ subscriptions: [], extensionUri: vscode.Uri.file(folder), extensionPath: folder } as unknown as vscode.ExtensionContext);
}

/** The paths `differ.conflictedFiles` was last set to, sorted; undefined before it is set. */
function conflictedFilesContext(): readonly string[] | undefined {
  const settings = vscodeMock.executedCommands.filter(({ command, args }) => command === "setContext" && args[0] === "differ.conflictedFiles");
  const paths = settings.at(-1)?.args[1] as readonly string[] | undefined;
  return paths && [...paths].sort();
}

/** Waits until the latest `differ.conflictedFiles` setting is `paths`, in any order. */
async function expectConflictedFiles(paths: readonly string[]): Promise<void> {
  await vi.waitFor(() => expect(conflictedFilesContext()).toEqual([...paths].sort()));
}

beforeEach(() => {
  resetVscodeMock();
  vscodeMock.openFileDocument = fileDocument;
  repo = createConflictRepository();
  links = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "differ-links-")));
});

afterEach(async () => {
  await deactivate();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(links, { recursive: true, force: true });
});

describe("conflicted files context key", () => {
  it("holds the conflicted files of the workspace repositories after activation", async () => {
    divergeBranches(repo, ["a.txt", "src/b.ts"]);
    mergeFeature(repo);
    vscodeMock.workspaceFolders = [workspaceFolder(repo)];

    activateExtension();

    await expectConflictedFiles([path.join(repo, "a.txt"), path.join(repo, "src", "b.ts")]);
  });

  it("is empty when nothing is conflicted", async () => {
    divergeBranches(repo, ["a.txt"]);
    vscodeMock.workspaceFolders = [workspaceFolder(repo)];

    activateExtension();

    await expectConflictedFiles([]);
  });

  it("refreshes when a repository's index changes", async () => {
    divergeBranches(repo, ["a.txt"]);
    vscodeMock.workspaceFolders = [workspaceFolder(repo)];
    activateExtension();
    await expectConflictedFiles([]);
    const [watcher] = vscodeMock.fileSystemWatchers;

    mergeFeature(repo);
    watcher.fireDidChange(vscode.Uri.file(path.join(repo, ".git", "index")));

    expect(watcher.globPattern).toBe("**/.git/index");
    await expectConflictedFiles([path.join(repo, "a.txt")]);
  });

  it("refreshes when the window gains focus, as after resolving in another program", async () => {
    divergeBranches(repo, ["a.txt"]);
    mergeFeature(repo);
    vscodeMock.workspaceFolders = [workspaceFolder(repo)];
    activateExtension();
    await expectConflictedFiles([path.join(repo, "a.txt")]);

    runGit(repo, "add", "a.txt");
    changeWindowFocus(true);

    await expectConflictedFiles([]);
  });

  it("refreshes when a workspace folder is added", async () => {
    divergeBranches(repo, ["a.txt"]);
    mergeFeature(repo);
    activateExtension();
    await expectConflictedFiles([]);

    changeWorkspaceFolders([workspaceFolder(repo)]);

    await expectConflictedFiles([path.join(repo, "a.txt")]);
  });

  it("also holds each file's path through a workspace folder opened by a symbolic link", async () => {
    divergeBranches(repo, ["a.txt"]);
    mergeFeature(repo);
    const link = path.join(links, "repo");
    fs.symlinkSync(repo, link);
    vscodeMock.workspaceFolders = [workspaceFolder(link)];

    activateExtension();

    await expectConflictedFiles([path.join(repo, "a.txt"), path.join(link, "a.txt")]);
  });

  it("runs one refresh at a time and reruns one asked for meanwhile, so a stale result is never shown", async () => {
    const finds: ((files: readonly string[]) => void)[] = [];
    const findConflictedFiles = (): Promise<readonly string[]> => new Promise((resolve) => finds.push(resolve));
    const context = new ConflictedFilesContext(findConflictedFiles);

    context.refresh();
    context.refresh();
    finds[0](["/stale.txt"]);
    await vi.waitFor(() => expect(finds).toHaveLength(2));
    finds[1](["/current.txt"]);

    await expectConflictedFiles(["/current.txt"]);
    expect(vscodeMock.executedCommands.filter(({ command }) => command === "setContext")).toHaveLength(1);
    context.dispose();
  });

  it("drops a refresh that finishes after disposal", async () => {
    const finds: ((files: readonly string[]) => void)[] = [];
    const context = new ConflictedFilesContext(() => new Promise((resolve) => finds.push(resolve)));

    context.dispose();
    finds[0](["/a.txt"]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(conflictedFilesContext()).toBeUndefined();
    expect(vscodeMock.fileSystemWatchers[0].isDisposed).toBe(true);
  });

  it("refreshes when a merge view closes, as after applying a merge stages the file", async () => {
    divergeBranches(repo, ["a.txt"]);
    mergeFeature(repo);
    vscodeMock.workspaceFolders = [workspaceFolder(repo)];
    activateExtension();
    await vscode.commands.executeCommand(COMMAND, vscode.Uri.file(path.join(repo, "a.txt")));
    await expectConflictedFiles([path.join(repo, "a.txt")]);

    runGit(repo, "add", "a.txt");
    vscodeMock.webviewPanels[0].dispose();

    await expectConflictedFiles([]);
  });
});

describe("Resolve Conflict in Differ", () => {
  beforeEach(() => {
    divergeBranches(repo, ["a.txt"]);
    mergeFeature(repo);
    vscodeMock.workspaceFolders = [workspaceFolder(repo)];
    activateExtension();
  });

  it("opens the merge view of the file an Explorer or editor tab menu passes", async () => {
    const uri = vscode.Uri.file(path.join(repo, "a.txt"));

    await vscode.commands.executeCommand(COMMAND, uri, [uri]);

    expect(vscodeMock.webviewPanels).toHaveLength(1);
    expect(vscodeMock.webviewPanels[0].webview.html).toContain("a.txt");
    expect(vscodeMock.messages).toEqual([]);
  });

  it("opens the merge view of the file a Source Control menu passes", async () => {
    const resourceState = { resourceUri: vscode.Uri.file(path.join(repo, "a.txt")) };

    await vscode.commands.executeCommand(COMMAND, resourceState);

    expect(vscodeMock.webviewPanels).toHaveLength(1);
    expect(vscodeMock.messages).toEqual([]);
  });

  it("opens the active file's merge view when run without a file, as from a key binding", async () => {
    const document = fileDocument(vscode.Uri.file(path.join(repo, "a.txt")));
    vscodeMock.activeTextEditor = { document } as vscode.TextEditor;

    await vscode.commands.executeCommand(COMMAND);

    await vi.waitFor(() => expect(vscodeMock.webviewPanels).toHaveLength(1));
  });

  it("reports a file it cannot open, such as a conflict's deleted side", async () => {
    await vscode.commands.executeCommand(COMMAND, vscode.Uri.file(path.join(repo, "gone.txt")));

    expect(vscodeMock.webviewPanels).toEqual([]);
    expect(vscodeMock.messages).toHaveLength(1);
    expect(vscodeMock.messages[0].level).toBe("error");
    expect(vscodeMock.messages[0].text).toContain("Differ could not open gone.txt.");
  });

  it("is offered on conflicted files in the Explorer, editor tabs and Git's merge changes, not in the palette", () => {
    const { commands, menus } = manifest.contributes;
    const entriesOf = (menu: string): readonly MenuEntry[] => menus[menu].filter((entry) => entry.command === COMMAND);

    expect(commands.find((entry) => entry.command === COMMAND)).toEqual({ command: COMMAND, title: "Resolve Conflict in Differ", category: "Differ" });
    expect(entriesOf("explorer/context")).toEqual([
      { command: COMMAND, when: "!explorerResourceIsFolder && resourcePath in differ.conflictedFiles", group: "navigation" },
    ]);
    expect(entriesOf("editor/title/context")).toEqual([{ command: COMMAND, when: "resourcePath in differ.conflictedFiles", group: "navigation" }]);
    expect(entriesOf("scm/resourceState/context")).toEqual([
      { command: COMMAND, when: "scmProvider == git && scmResourceGroup == merge", group: "navigation" },
    ]);
    expect(entriesOf("commandPalette")).toEqual([{ command: COMMAND, when: "false" }]);
  });
});
