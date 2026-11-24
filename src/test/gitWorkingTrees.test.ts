import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrivateWorkspace, runPrivateGit } from "../git/gitSelectionReplay";
import type { PrivateWorkspace } from "../git/gitSelectionReplay";
import { writeWorkingTrees } from "../git/gitWorkingTrees";
import type { WorkingTrees } from "../git/gitWorkingTrees";
import {
  captureRepositoryState,
  commitFiles,
  createHistoryRepository,
  disposeHistoryRepository,
  fixtureGitEnvironment,
  runFixtureGit,
} from "./gitHistoryFixture";
import type { FixtureFileChange, HistoryRepositoryFixture, RepositoryState } from "./gitHistoryFixture";

const signal = new AbortController().signal;
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Everything building working trees must leave as it was in the source repository. */
interface SourceSnapshot {
  readonly state: RepositoryState;
  readonly indexModifiedMs: number | null;
  /** Every file under `.git` with its size, so nothing is added, removed or rewritten to another length. */
  readonly gitFiles: readonly string[];
  /** Every file under the objects directory. */
  readonly objectFiles: readonly string[];
}

describe("writeWorkingTrees", () => {
  let fixture: HistoryRepositoryFixture;
  let temporaryParent: string;
  const workspaces: PrivateWorkspace[] = [];

  beforeEach(() => {
    fixture = createHistoryRepository();
    temporaryParent = path.join(fixture.directory, "tmp");
    fs.mkdirSync(temporaryParent);
  });

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
    disposeHistoryRepository(fixture);
  });

  function write(filePath: string, content: string | Uint8Array): FixtureFileChange {
    return { kind: "write", path: filePath, content };
  }

  function commit(message: string, ...changes: FixtureFileChange[]): string {
    return commitFiles(fixture.root, { message, changes });
  }

  function git(...args: string[]): string {
    return runFixtureGit(fixture.root, args);
  }

  function writeFile(filePath: string, content: string | Uint8Array): void {
    fs.mkdirSync(path.dirname(path.join(fixture.root, filePath)), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, filePath), content);
  }

  async function build(isWorktreeIncluded = true): Promise<{ workspace: PrivateWorkspace; trees: WorkingTrees }> {
    const env = fixtureGitEnvironment();
    const workspace = await createPrivateWorkspace(fixture.root, signal, { env, temporaryParent });
    workspaces.push(workspace);
    const source = { root: fixture.root, env, objectFormat: workspace.objectFormat, isWorktreeIncluded };
    return { workspace, trees: await writeWorkingTrees(workspace.repository, source, signal) };
  }

  /** Path → blob content (gitlinks → their commit OID) of a private tree. */
  async function contents(workspace: PrivateWorkspace, treeOid: string | null): Promise<Record<string, string>> {
    const listing = await runPrivateGit(workspace.repository, ["ls-tree", "-r", "-z", treeOid ?? ""], signal);
    const entries = listing.stdout.toString("utf8").split("\0").filter((entry) => entry !== "");
    const pairs = await Promise.all(entries.map(async (entry) => {
      const [mode = "", type = "", oid = ""] = entry.slice(0, entry.indexOf("\t")).split(" ");
      const entryPath = entry.slice(entry.indexOf("\t") + 1);
      if (type !== "blob") {
        return [entryPath, `${mode} ${oid}`] as const;
      }
      const blob = await runPrivateGit(workspace.repository, ["cat-file", "blob", oid], signal);
      return [entryPath, blob.stdout.toString("utf8")] as const;
    }));
    return Object.fromEntries(pairs);
  }

  function listFiles(directory: string, withSizes: boolean): readonly string[] {
    return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => {
        const absolutePath = path.join(entry.parentPath, entry.name);
        const relativePath = path.relative(directory, absolutePath);
        return withSizes ? `${relativePath} ${fs.statSync(absolutePath).size}` : relativePath;
      })
      .sort();
  }

  function snapshotSource(): SourceSnapshot {
    const gitDirectory = path.join(fixture.root, ".git");
    const indexStat = fs.statSync(path.join(gitDirectory, "index"), { throwIfNoEntry: false });
    return {
      state: captureRepositoryState(fixture.root),
      indexModifiedMs: indexStat?.mtimeMs ?? null,
      gitFiles: listFiles(gitDirectory, true),
      objectFiles: listFiles(path.join(gitDirectory, "objects"), false),
    };
  }

  function sampleChanges(): void {
    commit("A", write("a.txt", "a\n"), write("b.txt", "b\n"), write("c.txt", "c\n"));
    writeFile("a.txt", "staged\n");
    git("add", "a.txt");
    writeFile("b.txt", "unstaged\n");
    fs.rmSync(path.join(fixture.root, "c.txt"));
    writeFile("new/d.txt", "untracked\n");
  }

  it("writes the index tree and the tree of the files on disk", async () => {
    sampleChanges();

    const { workspace, trees } = await build();

    expect(await contents(workspace, trees.indexTreeOid)).toEqual({ "a.txt": "staged\n", "b.txt": "b\n", "c.txt": "c\n" });
    expect(await contents(workspace, trees.worktreeTreeOid))
      .toEqual({ "a.txt": "staged\n", "b.txt": "unstaged\n", "new/d.txt": "untracked\n" });
  });

  it("writes only the index tree unless the working tree is asked for", async () => {
    sampleChanges();

    const { trees } = await build(false);

    expect(trees.worktreeTreeOid).toBeNull();
  });

  it("turns off the built-in file-system monitor wherever it turns off the configured one", async () => {
    sampleChanges();
    const trace = path.join(fixture.directory, "trace.txt");
    const env = { ...fixtureGitEnvironment(), GIT_TRACE2: trace };
    const workspace = await createPrivateWorkspace(fixture.root, signal, { env, temporaryParent });
    workspaces.push(workspace);
    const source = { root: fixture.root, env, objectFormat: workspace.objectFormat, isWorktreeIncluded: true };

    await writeWorkingTrees(workspace.repository, source, signal);

    const starts = fs.readFileSync(trace, "utf8").split("\n").filter((line) => line.includes(" start git "));
    const monitored = starts.filter((line) => line.includes("core.fsmonitor=false"));
    expect(monitored.some((line) => line.includes(" status "))).toBe(true);
    expect(monitored.some((line) => line.includes(" update-index "))).toBe(true);
    for (const line of monitored) {
      expect(line).toContain("-c core.fsmonitor=false -c core.useBuiltinFSMonitor=false");
    }
  });

  it("leaves the source index, objects and Git directory as they were, even with a stale index", async () => {
    sampleChanges();
    const past = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(fixture.root, "a.txt"), past, past);
    const before = snapshotSource();

    await build();

    expect(snapshotSource()).toEqual(before);
  });

  it("runs none of the source repository's hooks while writing the private index copies", async () => {
    sampleChanges();
    const hooksDirectory = path.join(fixture.directory, "hooks");
    const marker = path.join(fixture.directory, "hook-ran");
    fs.mkdirSync(hooksDirectory);
    fs.writeFileSync(path.join(hooksDirectory, "post-index-change"), `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
    git("config", "core.hooksPath", hooksDirectory);

    await build();

    expect(fs.existsSync(marker)).toBe(false);
  });

  it("converts line endings and runs clean filters as git add does", async () => {
    commit("A", write("crlf.txt", "x\ny\n"), write(".gitattributes", "*.up filter=upper\n"));
    git("config", "core.autocrlf", "true");
    git("config", "filter.upper.clean", "tr a-z A-Z");
    writeFile("crlf.txt", "x\r\ny\r\n");
    writeFile("shout.up", "quiet\n");

    const { workspace, trees } = await build();

    const files = await contents(workspace, trees.worktreeTreeOid);
    expect(files["crlf.txt"]).toBe("x\ny\n");
    expect(files["shout.up"]).toBe("QUIET\n");
  });

  it("leaves intent-to-add files out of the index tree but not out of the working tree", async () => {
    commit("A", write("a.txt", "a\n"));
    writeFile("later.txt", "later\n");
    git("add", "--intent-to-add", "later.txt");

    const { workspace, trees } = await build();

    expect(await contents(workspace, trees.indexTreeOid)).toEqual({ "a.txt": "a\n" });
    expect(await contents(workspace, trees.worktreeTreeOid)).toEqual({ "a.txt": "a\n", "later.txt": "later\n" });
  });

  it("puts HEAD's side of a conflict in the index tree and the conflicted file in the working tree", async () => {
    commit("A", write("a.txt", "base\n"), write("gone.txt", "gone\n"));
    git("checkout", "-q", "-b", "side");
    commit("side", write("a.txt", "side\n"), write("gone.txt", "changed on side\n"));
    git("checkout", "-q", "main");
    commitFiles(fixture.root, { message: "main", changes: [write("a.txt", "main\n"), { kind: "delete", path: "gone.txt" }] });
    expect(() => git("merge", "-q", "side")).toThrow();
    const conflicted = fs.readFileSync(path.join(fixture.root, "a.txt"), "utf8");
    const before = snapshotSource();

    const { workspace, trees } = await build();

    expect(await contents(workspace, trees.indexTreeOid)).toEqual({ "a.txt": "main\n" });
    expect(await contents(workspace, trees.worktreeTreeOid))
      .toEqual({ "a.txt": conflicted, "gone.txt": "changed on side\n" });
    expect(snapshotSource()).toEqual(before);
  });

  it("builds trees on an unborn branch, and the empty tree without any index", async () => {
    const { trees: empty } = await build();
    writeFile("first.txt", "first\n");
    git("add", "first.txt");

    const { workspace, trees } = await build();

    expect(empty).toEqual({ indexTreeOid: EMPTY_TREE_OID, worktreeTreeOid: EMPTY_TREE_OID });
    expect(await contents(workspace, trees.indexTreeOid)).toEqual({ "first.txt": "first\n" });
  });

  it("keeps a submodule's recorded commit when its checkout has moved on", async () => {
    const nested = path.join(fixture.root, "module");
    fs.mkdirSync(nested);
    runFixtureGit(nested, ["init", "-q", "--template=", "-b", "main"]);
    runFixtureGit(nested, ["config", "user.name", "Test Author"]);
    runFixtureGit(nested, ["config", "user.email", "test@example.com"]);
    const recorded = commitFiles(nested, { message: "one", changes: [write("m.txt", "one\n")] });
    git("update-index", "--add", "--cacheinfo", `160000,${recorded},module`);
    commit("A", write("a.txt", "a\n"));
    commitFiles(nested, { message: "two", changes: [write("m.txt", "two\n")] });
    fs.writeFileSync(path.join(nested, "m.txt"), "dirty\n");

    const { workspace, trees } = await build();

    expect(await contents(workspace, trees.worktreeTreeOid)).toEqual({ "a.txt": "a\n", "module": `160000 ${recorded}` });
  });

  it("keeps files outside a sparse checkout and leaves the sparse index alone", async () => {
    commit("A", write("in/a.txt", "a\n"), write("out/b.txt", "b\n"));
    git("sparse-checkout", "set", "--cone", "--sparse-index", "in");
    writeFile("in/a.txt", "changed\n");
    const before = snapshotSource();

    const { workspace, trees } = await build();

    expect(fs.existsSync(path.join(fixture.root, "out"))).toBe(false);
    expect(await contents(workspace, trees.worktreeTreeOid)).toEqual({ "in/a.txt": "changed\n", "out/b.txt": "b\n" });
    expect(snapshotSource()).toEqual(before);
  });

  it("reads a split index without writing a shared index into the source repository", async () => {
    commit("A", write("a.txt", "a\n"), write("b.txt", "b\n"));
    git("config", "core.splitIndex", "true");
    git("update-index", "--split-index");
    writeFile("a.txt", "staged\n");
    git("add", "a.txt");
    writeFile("b.txt", "unstaged\n");
    expect(listFiles(path.join(fixture.root, ".git"), false).some((file) => file.startsWith("sharedindex."))).toBe(true);
    const before = snapshotSource();

    const { workspace, trees } = await build();

    expect(await contents(workspace, trees.indexTreeOid)).toEqual({ "a.txt": "staged\n", "b.txt": "b\n" });
    expect(await contents(workspace, trees.worktreeTreeOid)).toEqual({ "a.txt": "staged\n", "b.txt": "unstaged\n" });
    expect(snapshotSource()).toEqual(before);
  });
});
