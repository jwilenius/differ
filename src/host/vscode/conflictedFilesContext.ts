import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { GitIndexWatchers } from "./gitIndexWatchers";

/** Paths of the conflicted files, read by the `resourcePath in jwDiffer.conflictedFiles` menu conditions. */
const CONTEXT_CONFLICTED_FILES = "jwDiffer.conflictedFiles";
/** A Windows path's leading drive letter, as in `C:\repo`. */
const DRIVE_LETTER_PATTERN = /^[A-Za-z]:/;

/** What one search of the workspace's repositories found. */
export interface ConflictedFilesScan {
  /** Canonical paths of the conflicted files. */
  readonly files: readonly string[];
  /** Index files of the repositories searched, which Git rewrites whenever their conflicted files change. */
  readonly indexFiles: readonly string[];
}

/** Searches the workspace's repositories, reporting each failure through `onFailure` as a line to log. */
export type ConflictedFilesScanner = (onFailure: (failure: string) => void) => Promise<ConflictedFilesScan>;

/**
 * Keeps the `jwDiffer.conflictedFiles` context key current, so the Explorer and editor tab menus offer the merge view on
 * conflicted files. It refreshes on creation, when the window gains focus, when workspace folders change, when the index
 * of a repository the last refresh searched changes, and on `refresh()`. A failure is logged once while it lasts.
 */
export class ConflictedFilesContext implements vscode.Disposable {
  private isRefreshing = false;
  /** Set when a refresh is asked for while one runs; that one then runs again, as its result may be stale. */
  private isRefreshPending = false;
  private isDisposed = false;
  /** What the previous search failed on; it is not logged again while every search fails on it. */
  private previousFailures: ReadonlySet<string> = new Set();
  private readonly indexWatchers = new GitIndexWatchers(() => this.refresh());
  private readonly disposables: readonly vscode.Disposable[];

  constructor(
    private readonly scan: ConflictedFilesScanner,
    private readonly log: (line: string) => void,
  ) {
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
        const scan = await this.scanLoggingNewFailures();
        const paths = withDriveLetterCasings(await withWorkspaceFolderAliases(scan.files), process.platform);
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

  /** Searches, logging the failures the previous search did not have, so one that recurs on every refresh shows once. */
  private async scanLoggingNewFailures(): Promise<ConflictedFilesScan> {
    const failures = new Set<string>();
    const scan = await this.scan((failure) => failures.add(failure));
    if (!this.isDisposed) {
      [...failures].filter((failure) => !this.previousFailures.has(failure)).forEach((failure) => this.log(failure));
    }
    this.previousFailures = failures;
    return scan;
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

/**
 * `paths` plus, on Windows, each with its drive letter in both cases. The menus compare `resourcePath` exactly, which
 * comes from `Uri.fsPath` and so has a lowercase drive letter, while Git and `realpath` may give it in upper case.
 */
export function withDriveLetterCasings(paths: readonly string[], platform: NodeJS.Platform): readonly string[] {
  if (platform !== "win32") {
    return paths;
  }
  return [...new Set(paths.flatMap((filePath) => driveLetterCasings(filePath)))];
}

/** `filePath` with its drive letter in lower and in upper case; just `filePath` when it has none, as a UNC path. */
function driveLetterCasings(filePath: string): readonly string[] {
  if (!DRIVE_LETTER_PATTERN.test(filePath)) {
    return [filePath];
  }
  const afterDriveLetter = filePath.slice(1);
  return [filePath[0].toLowerCase() + afterDriveLetter, filePath[0].toUpperCase() + afterDriveLetter];
}
