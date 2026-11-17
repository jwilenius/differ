import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConflictedFilesContext, type ConflictedFilesScan, withDriveLetterCasings } from "../host/vscode/conflictedFilesContext";
import { activate, deactivate } from "../host/vscode/extension";
import { createConflictRepository, divergeBranches, mergeFeature, runGit } from "./gitConflictFixture";
import {
  changeWindowFocus,
  changeWorkspaceFolders,
  type ExecutedCommand,
  type FakeExtension,
  type FakeFileSystemWatcher,
  RelativePattern,
  resetVscodeMock,
  vscodeMock,
} from "./vscodeMock";

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

const COMMAND = "jwDiffer.resolveConflictInFile";

/** An installed colour theme, so opening a merge view raises no missing-theme warning. */
const INSTALLED_THEME: FakeExtension = {
  id: "test.theme",
  extensionPath: path.join(__dirname, "fixtures", "highlight", "themes"),
  packageJSON: { contributes: { themes: [{ id: "Test Theme", uiTheme: "vs-dark", path: "./base.json" }] } },
};
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

/** Each setting of `jwDiffer.conflictedFiles`, one per refresh that finished current. */
function conflictedFilesSettings(): readonly ExecutedCommand[] {
  return vscodeMock.executedCommands.filter(({ command, args }) => command === "setContext" && args[0] === "jwDiffer.conflictedFiles");
}

/** The paths `jwDiffer.conflictedFiles` was last set to, sorted; undefined before it is set. */
function conflictedFilesContext(): readonly string[] | undefined {
  const paths = conflictedFilesSettings().at(-1)?.args[1] as readonly string[] | undefined;
  return paths && [...paths].sort();
}

/** Waits until the latest `jwDiffer.conflictedFiles` setting is `paths`, in any order. */
async function expectConflictedFiles(paths: readonly string[]): Promise<void> {
  await vi.waitFor(() => expect(conflictedFilesContext()).toEqual([...paths].sort()));
}

/** The watchers not yet disposed, as the index files they watch. */
function watchedIndexFiles(): readonly string[] {
  return vscodeMock.fileSystemWatchers
    .filter((watcher) => !watcher.isDisposed)
    .map(({ globPattern }) => (globPattern instanceof RelativePattern ? path.join(globPattern.baseUri.fsPath, globPattern.pattern) : globPattern));
}

/** Waits for the one watcher of `indexFile` still watching. */
async function indexWatcher(indexFile: string): Promise<FakeFileSystemWatcher> {
  await vi.waitFor(() => expect(watchedIndexFiles()).toContain(indexFile));
  const watchers = vscodeMock.fileSystemWatchers.filter((watcher) => !watcher.isDisposed);
  return watchers[watchedIndexFiles().indexOf(indexFile)];
}

/**
 * Activates with `folder` open, whose repository `merge` then leaves conflicted, and expects reporting a change of
 * `indexFile` to list `conflictedFile`.
 */
async function expectIndexChangeRefreshes(folder: string, indexFile: string, merge: () => void, conflictedFile: string): Promise<void> {
  vscodeMock.workspaceFolders = [workspaceFolder(folder)];
  activateExtension();
  await expectConflictedFiles([]);
  const watcher = await indexWatcher(indexFile);

  merge();
  watcher.fireDidChange(vscode.Uri.file(indexFile));

  await expectConflictedFiles([conflictedFile]);
}

beforeEach(() => {
  resetVscodeMock();
  vscodeMock.openFileDocument = fileDocument;
  repo = createConflictRepository();
  links = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jw-differ-links-")));
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

    await expectIndexChangeRefreshes(repo, path.join(repo, ".git", "index"), () => mergeFeature(repo), path.join(repo, "a.txt"));
    expect(watchedIndexFiles()).toEqual([path.join(repo, ".git", "index")]);
  });

  it("watches the index above a workspace folder inside the repository", async () => {
    divergeBranches(repo, ["src/b.ts"]);

    await expectIndexChangeRefreshes(path.join(repo, "src"), path.join(repo, ".git", "index"), () => mergeFeature(repo), path.join(repo, "src", "b.ts"));
  });

  it("watches a linked worktree's index in the main repository's git directory", async () => {
    divergeBranches(repo, ["a.txt"]);
    const worktree = path.join(links, "worktree");
    runGit(repo, "worktree", "add", "-q", "-b", "other", worktree, "trunk");

    const indexFile = path.join(repo, ".git", "worktrees", "worktree", "index");
    await expectIndexChangeRefreshes(worktree, indexFile, () => mergeFeature(worktree), path.join(worktree, "a.txt"));
  });

  it("watches a submodule's index in the superproject's git directory", async () => {
    divergeBranches(repo, ["a.txt"]);
    const superproject = path.join(links, "super");
    runGit(links, "init", "-q", superproject);
    runGit(superproject, "-c", "protocol.file.allow=always", "submodule", "add", "-q", repo, "module");
    const module = path.join(superproject, "module");
    const mergeIntoModule = (): void => {
      try {
        runGit(module, "merge", "origin/feature");
      } catch {
        // The merge is expected to conflict.
      }
    };

    const indexFile = path.join(superproject, ".git", "modules", "module", "index");
    await expectIndexChangeRefreshes(module, indexFile, mergeIntoModule, path.join(module, "a.txt"));
  });

  it("keeps one watcher per index and stops it once its repository is no longer searched", async () => {
    divergeBranches(repo, ["src/b.ts"]);
    vscodeMock.workspaceFolders = [workspaceFolder(repo), workspaceFolder(path.join(repo, "src"))];
    activateExtension();
    const watcher = await indexWatcher(path.join(repo, ".git", "index"));
    await vi.waitFor(() => expect(conflictedFilesSettings()).toHaveLength(1));

    changeWindowFocus(true);
    await vi.waitFor(() => expect(conflictedFilesSettings()).toHaveLength(2));
    expect(vscodeMock.fileSystemWatchers).toEqual([watcher]);

    changeWorkspaceFolders([]);

    await vi.waitFor(() => expect(watcher.isDisposed).toBe(true));
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
    const context = new ConflictedFilesContext(async () => ({ files: await findConflictedFiles(), indexFiles: [] }), () => undefined);

    context.refresh();
    context.refresh();
    finds[0](["/stale.txt"]);
    await vi.waitFor(() => expect(finds).toHaveLength(2));
    finds[1](["/current.txt"]);

    await expectConflictedFiles(["/current.txt"]);
    expect(conflictedFilesSettings()).toHaveLength(1);
    context.dispose();
  });

  it("drops a refresh that finishes after disposal", async () => {
    const finds: ((scan: ConflictedFilesScan) => void)[] = [];
    const context = new ConflictedFilesContext(() => new Promise((resolve) => finds.push(resolve)), () => undefined);

    context.dispose();
    finds[0]({ files: ["/a.txt"], indexFiles: ["/.git/index"] });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(conflictedFilesContext()).toBeUndefined();
    expect(vscodeMock.fileSystemWatchers).toEqual([]);
  });

  it("logs a failure once while every refresh fails on it, and again once it changes or recurs", async () => {
    const failuresByScan = [["Git is missing."], ["Git is missing."], ["Git is broken."], [], ["Git is broken."]];
    const lines: string[] = [];
    const context = new ConflictedFilesContext(async (onFailure) => {
      failuresByScan.shift()?.forEach(onFailure);
      return { files: [], indexFiles: [] };
    }, (line) => lines.push(line));

    for (const refreshes of [1, 2, 3, 4]) {
      await vi.waitFor(() => expect(conflictedFilesSettings()).toHaveLength(refreshes));
      context.refresh();
    }

    await vi.waitFor(() => expect(conflictedFilesSettings()).toHaveLength(5));
    expect(lines).toEqual(["Git is missing.", "Git is broken.", "Git is broken."]);
    context.dispose();
  });

  it("logs that Git is missing once, not on every refresh", async () => {
    vscodeMock.workspaceFolders = [workspaceFolder(repo)];
    const inheritedPath = process.env.PATH;
    process.env.PATH = links;
    try {
      activateExtension();
      for (const refreshes of [1, 2, 3]) {
        await vi.waitFor(() => expect(conflictedFilesSettings()).toHaveLength(refreshes));
        changeWindowFocus(true);
      }
      await vi.waitFor(() => expect(conflictedFilesSettings()).toHaveLength(4));
    } finally {
      process.env.PATH = inheritedPath;
    }

    const failures = vscodeMock.outputChannels[0].lines.filter((line) => line.startsWith(`Listing conflicts in ${repo} failed.`));
    expect(failures).toHaveLength(1);
  });

  it("lists the conflicts of a repository whose index cannot be found", async () => {
    divergeBranches(repo, ["a.txt"]);
    mergeFeature(repo);
    vscodeMock.workspaceFolders = [workspaceFolder(repo)];
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const gitFailingIndexLookup = `#!/bin/sh\ncase "$*" in *--git-path*) exit 1 ;; esac\nexec "${realGit}" "$@"\n`;
    fs.writeFileSync(path.join(links, "git"), gitFailingIndexLookup, { mode: 0o755 });
    const inheritedPath = process.env.PATH;
    process.env.PATH = links;
    try {
      activateExtension();
      await expectConflictedFiles([path.join(repo, "a.txt")]);
    } finally {
      process.env.PATH = inheritedPath;
    }

    expect(watchedIndexFiles()).toEqual([]);
    expect(vscodeMock.outputChannels[0].lines).toContainEqual(expect.stringMatching(`^Finding the Git index of ${repo} failed.`));
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

describe("withDriveLetterCasings", () => {
  it("adds each Windows path with its drive letter in the other case, as `Uri.fsPath` lowercases it", () => {
    const paths = ["C:\\repo\\a.txt", "d:\\repo\\b.txt", "\\\\server\\share\\c.txt"];

    expect(withDriveLetterCasings(paths, "win32")).toEqual([
      "c:\\repo\\a.txt",
      "C:\\repo\\a.txt",
      "d:\\repo\\b.txt",
      "D:\\repo\\b.txt",
      "\\\\server\\share\\c.txt",
    ]);
  });

  it("adds a path once when both casings are already listed", () => {
    expect(withDriveLetterCasings(["c:\\a.txt", "C:\\a.txt"], "win32")).toEqual(["c:\\a.txt", "C:\\a.txt"]);
  });

  it("leaves other platforms' paths alone", () => {
    expect(withDriveLetterCasings(["/repo/a.txt", "C:/not-a-drive"], "linux")).toEqual(["/repo/a.txt", "C:/not-a-drive"]);
  });
});

describe("Resolve Conflict in jw-differ", () => {
  beforeEach(() => {
    divergeBranches(repo, ["a.txt"]);
    mergeFeature(repo);
    vscodeMock.workspaceFolders = [workspaceFolder(repo)];
    vscodeMock.extensions = [INSTALLED_THEME];
    vscodeMock.configuration.set("workbench.colorTheme", "Test Theme");
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
    expect(vscodeMock.messages[0].text).toContain("jw-differ could not open gone.txt.");
  });

  it("is offered on conflicted files in the Explorer, editor tabs and Git's merge changes, not in the palette", () => {
    const { commands, menus } = manifest.contributes;
    const entriesOf = (menu: string): readonly MenuEntry[] => menus[menu].filter((entry) => entry.command === COMMAND);

    expect(commands.find((entry) => entry.command === COMMAND)).toEqual({ command: COMMAND, title: "Resolve Conflict in jw-differ", category: "jw-differ" });
    expect(entriesOf("explorer/context")).toEqual([
      { command: COMMAND, when: "!explorerResourceIsFolder && resourcePath in jwDiffer.conflictedFiles", group: "navigation" },
    ]);
    expect(entriesOf("editor/title/context")).toEqual([{ command: COMMAND, when: "resourcePath in jwDiffer.conflictedFiles", group: "navigation" }]);
    // VS Code builds Source Control resource menus without the resource's context keys (checked in 1.90 and on main,
    // November 2026), so `resourcePath` there is not the clicked file's and cannot narrow the entry to mergeable files.
    expect(entriesOf("scm/resourceState/context")).toEqual([
      { command: COMMAND, when: "scmProvider == git && scmResourceGroup == merge", group: "navigation" },
    ]);
    expect(entriesOf("commandPalette")).toEqual([{ command: COMMAND, when: "false" }]);
  });
});
