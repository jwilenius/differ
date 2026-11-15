import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

/** Paths of the conflicted files, read by the `resourcePath in differ.conflictedFiles` menu conditions. */
const CONTEXT_CONFLICTED_FILES = "differ.conflictedFiles";
/** Git rewrites the index whenever a merge, `git add` or checkout changes which files are conflicted. */
const GIT_INDEX_PATTERN = "**/.git/index";

/**
 * Keeps the `differ.conflictedFiles` context key current, so the Explorer and editor tab menus offer the merge view on
 * conflicted files. It refreshes on creation, when the window gains focus, when workspace folders change, when the index
 * of a repository inside a workspace folder changes, and on `refresh()`.
 */
export class ConflictedFilesContext implements vscode.Disposable {
  private isRefreshing = false;
  /** Set when a refresh is asked for while one runs; that one then runs again, as its result may be stale. */
  private isRefreshPending = false;
  private isDisposed = false;
  private readonly disposables: readonly vscode.Disposable[];

  constructor(private readonly findConflictedFiles: () => Promise<readonly string[]>) {
    const refresh = (): void => this.refresh();
    const indexWatcher = vscode.workspace.createFileSystemWatcher(GIT_INDEX_PATTERN);
    this.disposables = [
      indexWatcher,
      indexWatcher.onDidChange(refresh),
      indexWatcher.onDidCreate(refresh),
      indexWatcher.onDidDelete(refresh),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    ];
    refresh();
  }

  /** Updates the key; one refresh runs at a time, so a burst of index changes starts at most one more. */
  refresh(): void {
    if (this.isDisposed) {
      return;
    }
    if (this.isRefreshing) {
      this.isRefreshPending = true;
      return;
    }
    void this.refreshUntilCurrent();
  }

  dispose(): void {
    this.isDisposed = true;
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async refreshUntilCurrent(): Promise<void> {
    this.isRefreshing = true;
    try {
      do {
        this.isRefreshPending = false;
        const paths = await withWorkspaceFolderAliases(await this.findConflictedFiles());
        const isCurrent = !this.isRefreshPending && !this.isDisposed;
        if (isCurrent) {
          await vscode.commands.executeCommand("setContext", CONTEXT_CONFLICTED_FILES, paths);
        }
      } while (this.isRefreshPending && !this.isDisposed);
    } finally {
      this.isRefreshing = false;
    }
  }
}

/**
 * `files`, which are canonical, plus their paths through each workspace folder opened by a path with a symbolic link in
 * it, as the Explorer shows them there. Only membership is read, so the order does not matter.
 */
async function withWorkspaceFolderAliases(files: readonly string[]): Promise<readonly string[]> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file");
  const aliases = await Promise.all(folders.map((folder) => aliasesInFolder(folder.uri.fsPath, files)));
  return [...new Set([...files, ...aliases.flat()])];
}

/** The paths through `folder` of the `files` inside its canonical location; none when that is `folder` itself. */
async function aliasesInFolder(folder: string, files: readonly string[]): Promise<readonly string[]> {
  // A folder that cannot be resolved, such as a deleted one, holds no conflicted files.
  const canonicalFolder = await realpath(folder).catch(() => folder);
  if (canonicalFolder === folder) {
    return [];
  }
  return files
    .filter((file) => file.startsWith(`${canonicalFolder}${path.sep}`))
    .map((file) => path.join(folder, path.relative(canonicalFolder, file)));
}
