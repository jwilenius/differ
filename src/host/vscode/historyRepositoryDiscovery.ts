import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { runHistoryGit } from "../../git/historyGitCommand";

/** Canonical repository root containing a directory, or null when it is not in a repository. */
export type RepositoryRootFinder = (directory: string) => Promise<string | null>;

export interface RepositoryDiscoveryResult {
  /** Distinct roots in the order their directories were given. */
  readonly roots: readonly string[];
  /** Why a directory could not be inspected, such as Git missing; null when every lookup ran. */
  readonly problem: string | null;
}

/** Local folders of the workspace and the active editor, active editor first. */
export function candidateDirectories(): readonly string[] {
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  const editorDirectories = editorUri?.scheme === "file" ? [path.dirname(editorUri.fsPath)] : [];
  const folderDirectories = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
  return [...editorDirectories, ...folderDirectories];
}

/** Looks up each directory's root in turn; a failing lookup is reported through `onError` and skipped. */
export async function discoverRepositoryRoots(
  directories: readonly string[],
  findRoot: RepositoryRootFinder,
  onError: (directory: string, error: unknown) => void,
): Promise<RepositoryDiscoveryResult> {
  const roots: string[] = [];
  let problem: string | null = null;
  for (const directory of directories) {
    try {
      const root = await findRoot(directory);
      if (root !== null && !roots.includes(root)) {
        roots.push(root);
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
      onError(directory, error);
    }
  }
  return { roots, problem };
}

/** `rev-parse --show-toplevel`, canonicalised; null when `directory` is not in a work tree. Missing Git throws. */
export async function findGitRepositoryRoot(directory: string): Promise<string | null> {
  const result = await runHistoryGit({ cwd: directory, args: ["rev-parse", "--show-toplevel"], allowedExitCodes: [0, 128] });
  if (result.exitCode !== 0) {
    return null;
  }
  const topLevel = result.stdout.toString("utf8").replace(/\n$/, "");
  return topLevel === "" ? null : realpath(topLevel);
}
