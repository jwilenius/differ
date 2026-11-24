import * as path from "node:path";
import * as vscode from "vscode";

/**
 * One watcher per Git index file, each calling `onChange`. An index under a workspace folder is covered by VS Code's
 * workspace watcher; one outside it, as a linked worktree's or a submodule's is, gets a watcher of its own.
 */
export class GitIndexWatchers implements vscode.Disposable {
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
