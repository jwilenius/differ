import * as path from "node:path";
import { runHistoryGit } from "./historyGitCommand";

/** Absolute paths of the files with unmerged index entries in the repository at `root`, in Git's order. */
export async function listConflictedFiles(root: string): Promise<readonly string[]> {
  const result = await runHistoryGit({ cwd: root, args: ["diff", "--name-only", "--diff-filter=U", "-z"] });
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((name) => name !== "")
    .map((name) => path.join(root, name));
}
