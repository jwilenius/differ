import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

/** Paths of the conflicted files, read by the `resourcePath in differ.conflictedFiles` menu conditions. */
const CONTEXT_CONFLICTED_FILES = "differ.conflictedFiles";

/** What one search of the workspace's repositories found. */
export interface ConflictedFilesScan {
  /** Canonical paths of the conflicted files. */
  readonly files: readonly string[];
  /** Index files of the repositories searched, which Git rewrites whenever their conflicted files change. */
  readonly indexFiles: readonly string[];
}

/**
 * Keeps the `differ.conflictedFiles` context key current, so the Explorer and editor tab menus offer the merge view on
 * conflicted files. It refreshes on creation, when the window gains focus, when workspace folders change, when the index
 * of a repository the last refresh searched changes, and on `refresh()`.
 */
export class ConflictedFilesContext implements vscode.Disposable {
  private isRefreshing = false;
  /** Set when a refresh is asked for while one runs; that one then runs again, as its result may be stale. */
  private isRefreshPending = false;
  private isDisposed = false;
  private readonly indexWatchers = new GitIndexWatchers(() => this.refresh());
  private readonly disposables: readonly vscode.Disposable[];

  constructor(private readonly scan: () => Promise<ConflictedFilesScan>) {
    const refresh = (): void => this.refresh();
    this.disposables = [
      this.indexWatchers,
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
        const scan = await this.scan();
        const paths = await withWorkspaceFolderAliases(scan.files);
        const isCurrent = !this.isRefreshPending && !this.isDisposed;
        if (isCurrent) {
          this.indexWatchers.watch(scan.indexFiles);
          await vscode.commands.executeCommand("setContext", CONTEXT_CONFLICTED_FILES, paths);
        }
      } while (this.isRefreshPending && !this.isDisposed);
    } finally {
      this.isRefreshing = false;
    }
  }
}

/**
 * One watcher per Git index file, each calling `onChange`. A pattern based on a folder outside the workspace, as the
 * git directory of a linked worktree or submodule is, starts a watcher of its own; inside it, the workspace's serves.
 */
class GitIndexWatchers implements vscode.Disposable {
  private readonly watchersByIndexFile = new Map<string, vscode.Disposable>();

  constructor(private readonly onChange: () => void) {}

  /** Watches exactly `indexFiles`: keeps the watchers of those already watched and stops the others. */
  watch(indexFiles: readonly string[]): void {
    const wantedIndexFiles = new Set(indexFiles);
    for (const [indexFile, watcher] of this.watchersByIndexFile) {
      if (!wantedIndexFiles.has(indexFile)) {
        watcher.dispose();
        this.watchersByIndexFile.delete(indexFile);
      }
    }
    for (const indexFile of wantedIndexFiles) {
      if (!this.watchersByIndexFile.has(indexFile)) {
        this.watchersByIndexFile.set(indexFile, this.watchIndexFile(indexFile));
      }
    }
  }

  dispose(): void {
    this.watchersByIndexFile.forEach((watcher) => watcher.dispose());
    this.watchersByIndexFile.clear();
  }

  private watchIndexFile(indexFile: string): vscode.Disposable {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(indexFile)), path.basename(indexFile));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = (): void => this.onChange();
    return vscode.Disposable.from(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange), watcher.onDidDelete(onChange));
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
