import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHistoryRepository } from "../git/gitHistoryRepository";
import { resolveHistoryComparison } from "../git/historyComparisonResolver";
import type { ResolvedHistoryComparison } from "../git/historyComparisonResolver";
import { HistoryGitError } from "../git/historyGitCommand";
import { HistoryReplayStorageError, replaySelection, runPrivateGit } from "../git/gitSelectionReplay";
import type { ReplayBlockedResult, ReplayResult, ReplaySession } from "../git/gitSelectionReplay";
import type { BaseSelection, MainlineChoice } from "../model/historyTypes";
import {
  captureRepositoryState,
  commitFiles,
  createHistoryRepository,
  disposeHistoryRepository,
  fixtureGitEnvironment,
  runFixtureGit,
} from "./gitHistoryFixture";
import type { FixtureFileChange, HistoryRepositoryFixture } from "./gitHistoryFixture";

const signal = new AbortController().signal;
const AUTOMATIC: BaseSelection = { kind: "automatic" };
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const BINARY_BYTES = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x0d, 0x0a]);

describe("replaySelection", () => {
  let fixture: HistoryRepositoryFixture;
  let temporaryParent: string;
  const sessions: ReplaySession[] = [];

  beforeEach(() => {
    fixture = createHistoryRepository();
    temporaryParent = path.join(fixture.directory, "tmp");
    fs.mkdirSync(temporaryParent);
  });

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.dispose()));
    disposeHistoryRepository(fixture);
  });

  function write(filePath: string, content: string | Uint8Array): FixtureFileChange {
    return { kind: "write", path: filePath, content };
  }

  function commit(message: string, ...changes: FixtureFileChange[]): string {
    return commitFiles(fixture.root, { message, changes, isEmptyAllowed: changes.length === 0 });
  }

  function git(...args: string[]): string {
    return runFixtureGit(fixture.root, args).trim();
  }

  function treeOf(oid: string): string {
    return git("rev-parse", `${oid}^{tree}`);
  }

  function pinned(oid: string): BaseSelection {
    return { kind: "pinned", oid, label: oid };
  }

  /** Main: A adds a.txt, B b.txt, C c.txt, D d.txt. */
  function linearHistory(): readonly [string, string, string, string] {
    const a = commit("A", write("a.txt", "a\n"));
    const b = commit("B", write("b.txt", "b\n"));
    const c = commit("C", write("c.txt", "c\n"));
    return [a, b, c, commit("D", write("d.txt", "d\n"))];
  }

  async function resolve(
    selectedOids: readonly string[],
    base: BaseSelection = AUTOMATIC,
    mainlines: readonly MainlineChoice[] = [],
    root = fixture.root,
  ): Promise<ResolvedHistoryComparison> {
    const resolution = await resolveHistoryComparison(
      new GitHistoryRepository(root, fixtureGitEnvironment()),
      { selectedOids, base, mainlines },
      signal,
    );
    if (resolution.kind !== "resolved") {
      throw new Error("Expected a resolved comparison.");
    }
    return resolution;
  }

  async function replay(comparison: ResolvedHistoryComparison, root = fixture.root): Promise<ReplayResult> {
    const env = fixtureGitEnvironment();
    return replaySelection(root, comparison, signal, { env, temporaryParent });
  }

  /** Replays and asserts the source repository is byte-for-byte unchanged. */
  async function replayIsolated(comparison: ResolvedHistoryComparison, root = fixture.root): Promise<ReplayResult> {
    const before = captureRepositoryState(root);
    const result = await replay(comparison, root);
    expect(captureRepositoryState(root)).toEqual(before);
    return result;
  }

  async function replayed(comparison: ResolvedHistoryComparison, root = fixture.root): Promise<ReplaySession> {
    const result = await replayIsolated(comparison, root);
    if (result.kind !== "replayed") {
      throw new Error(`Expected a replayed session, got ${JSON.stringify(result)}.`);
    }
    sessions.push(result.session);
    return result.session;
  }

  async function blocked(comparison: ResolvedHistoryComparison): Promise<ReplayBlockedResult> {
    const result = await replayIsolated(comparison);
    if (result.kind !== "blocked") {
      throw new Error("Expected a blocked replay.");
    }
    return result;
  }

  async function resultEntries(session: ReplaySession): Promise<string> {
    const listing = await runPrivateGit(session.repository, ["ls-tree", "-r", session.resultTreeOid], signal);
    return listing.stdout.toString("utf8");
  }

  async function resultPaths(session: ReplaySession): Promise<readonly string[]> {
    const args = ["ls-tree", "-r", "--name-only", "-z", session.resultTreeOid];
    const listing = await runPrivateGit(session.repository, args, signal);
    return listing.stdout.toString("utf8").split("\0").filter((entry) => entry !== "");
  }

  function temporaryEntries(): readonly string[] {
    return fs.readdirSync(temporaryParent);
  }

  it("applies only the selected commits of a non-contiguous selection", async () => {
    const [a, b, , d] = linearHistory();

    const session = await replayed(await resolve([d, b]));

    expect(session.baseTreeOid).toBe(treeOf(a));
    expect(await resultPaths(session)).toEqual(["a.txt", "b.txt", "d.txt"]);
  });

  it("produces the latest tree for consecutive selected commits", async () => {
    const [a, b, c, d] = linearHistory();

    const session = await replayed(await resolve([b, c, d]));

    expect(session.baseTreeOid).toBe(treeOf(a));
    expect(session.resultTreeOid).toBe(treeOf(d));
  });

  it("replays a root commit onto the empty tree", async () => {
    const [a] = linearHistory();

    const session = await replayed(await resolve([a]));

    expect(session.baseTreeOid).toBe(EMPTY_TREE_OID);
    expect(session.resultTreeOid).toBe(treeOf(a));
  });

  it("composes independent edits of the same file", async () => {
    const lines = (second: string, ninth: string): string => `1\n${second}\n3\n4\n5\n6\n7\n8\n${ninth}\n10\n`;
    const a = commit("A", write("f.txt", lines("2", "9")));
    commit("B", write("f.txt", lines("two", "9")));
    const c = commit("C", write("f.txt", lines("two", "nine")));

    const session = await replayed(await resolve([c], pinned(a)));

    const blobArgs = ["cat-file", "blob", `${session.resultTreeOid}:f.txt`];
    const blob = await runPrivateGit(session.repository, blobArgs, signal);
    expect(blob.stdout.toString("utf8")).toBe(lines("2", "nine"));
  });

  it("blocks at a commit whose edit conflicts with the replayed content", async () => {
    const a = commit("A", write("f.txt", "1\n"));
    commit("B", write("f.txt", "2\n"));
    const c = commit("C", write("f.txt", "3\n"));

    const result = await blocked(await resolve([c], pinned(a)));

    expect(result.failingOid).toBe(c);
    expect(result.paths).toEqual(["f.txt"]);
    expect(result.explanation).toContain("conflict");
    expect(temporaryEntries()).toEqual([]);
  });

  it("blocks with the commit's paths when its patch needs a file that was not replayed", async () => {
    const [, b] = linearHistory();
    const e = commit("E", write("c.txt", "changed\n"), write("e.txt", "e\n"));

    const result = await blocked(await resolve([b, e]));

    expect(result.failingOid).toBe(e);
    expect(result.paths).toEqual(["c.txt", "e.txt"]);
    expect(result.explanation).toContain("could not be applied");
    expect(temporaryEntries()).toEqual([]);
  });

  it("replays binary additions, deletions and renames", async () => {
    commit("A", write("a.txt", "a\n"), write("old.txt", "kept content\n"));
    const b = commit("B", write("data.bin", BINARY_BYTES));
    const c = commitFiles(fixture.root, { message: "C", changes: [{ kind: "delete", path: "a.txt" }] });
    git("mv", "old.txt", "new.txt");
    const d = commitFiles(fixture.root, { message: "D", changes: [] });

    const session = await replayed(await resolve([b, c, d]));

    expect(session.resultTreeOid).toBe(treeOf(d));
    expect(await resultEntries(session)).toContain(`${git("rev-parse", `${b}:data.bin`)}\tdata.bin`);
  });

  it("keeps an empty commit as a no-op", async () => {
    const a = commit("A", write("a.txt", "a\n"));
    const empty = commit("Empty");

    const comparison = await resolve([empty]);
    const session = await replayed(comparison);

    expect(comparison.steps.map((step) => step.oid)).toEqual([empty]);
    expect(session.resultTreeOid).toBe(treeOf(a));
  });

  it("takes a merge's patch against the chosen mainline parent", async () => {
    const a = commit("A", write("a.txt", "a\n"));
    git("switch", "-q", "-c", "side");
    commit("S", write("s.txt", "s\n"));
    git("switch", "-q", "main");
    commit("M1", write("m.txt", "m\n"));
    git("merge", "-q", "--no-ff", "--no-edit", "side");
    const merge = git("rev-parse", "HEAD");

    const first = await replayed(await resolve([merge], pinned(a)));
    const second = await replayed(await resolve([merge], pinned(a), [{ oid: merge, parentNumber: 2 }]));

    expect(await resultPaths(first)).toEqual(["a.txt", "s.txt"]);
    expect(await resultPaths(second)).toEqual(["a.txt", "m.txt"]);
  });

  it("replays from a linked worktree", async () => {
    const [, b, , d] = linearHistory();
    const worktree = path.join(fixture.directory, "worktree");
    git("worktree", "add", "-q", "-b", "feature", worktree, "HEAD");

    const session = await replayed(await resolve([b, d], AUTOMATIC, [], worktree), worktree);

    expect(await resultPaths(session)).toEqual(["a.txt", "b.txt", "d.txt"]);
  });

  it("ignores a dirty, unmerged source index", async () => {
    const a = commit("A", write("f.txt", "base\n"));
    git("switch", "-q", "-c", "side");
    const side = commit("Side", write("f.txt", "side\n"));
    git("switch", "-q", "main");
    commit("Main", write("f.txt", "main\n"));
    expect(() => git("merge", "-q", "side")).toThrow();
    fs.writeFileSync(path.join(fixture.root, "untracked.txt"), "dirty\n");

    const session = await replayed(await resolve([side], pinned(a)));

    expect(session.resultTreeOid).toBe(treeOf(side));
  });

  it("writes no objects into the source even when the environment points there", async () => {
    const [, b, , d] = linearHistory();
    const sourceObjects = git("rev-parse", "--path-format=absolute", "--git-path", "objects");
    const objectsBefore = git("count-objects");
    const env = { ...fixtureGitEnvironment(), GIT_OBJECT_DIRECTORY: sourceObjects };

    const result = await replaySelection(fixture.root, await resolve([b, d]), signal, { env, temporaryParent });

    expect(result.kind).toBe("replayed");
    if (result.kind === "replayed") {
      sessions.push(result.session);
    }
    expect(git("count-objects")).toBe(objectsBefore);
  });

  it("borrows objects from a repository whose path needs quoting", async () => {
    const [, b, , d] = linearHistory();
    const oddRoot = path.join(fixture.directory, "odd \"quote\" \\ back\nline:colon");
    fs.renameSync(fixture.root, oddRoot);

    const session = await replayed(await resolve([b, d], AUTOMATIC, [], oddRoot), oddRoot);

    expect(await resultPaths(session)).toEqual(["a.txt", "b.txt", "d.txt"]);
  });

  it("removes the private repository on dispose", async () => {
    const [, b] = linearHistory();
    const session = await replayed(await resolve([b]));
    expect(temporaryEntries()).toHaveLength(1);

    await session.dispose();
    await session.dispose();

    expect(temporaryEntries()).toEqual([]);
  });

  it("reports a temporary storage failure without naming private paths", async () => {
    const [, b] = linearHistory();
    const missingParent = path.join(fixture.directory, "missing");
    const options = { env: fixtureGitEnvironment(), temporaryParent: missingParent };

    const error = await replaySelection(fixture.root, await resolve([b]), signal, options).catch((reason) => reason);

    expect(error).toBeInstanceOf(HistoryReplayStorageError);
    expect((error as HistoryReplayStorageError).message).not.toContain(fixture.directory);
    expect((error as HistoryReplayStorageError).detail).toContain(missingParent);
  });

  it("removes the private repository when cancelled mid-replay", async () => {
    const [, b, , d] = linearHistory();
    const comparison = await resolve([b, d]);
    const controller = new AbortController();
    const watcher = fs.watch(temporaryParent, () => controller.abort());

    try {
      const options = { env: fixtureGitEnvironment(), temporaryParent };
      const replay = replaySelection(fixture.root, comparison, controller.signal, options);
      const error = await replay.catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(HistoryGitError);
      expect((error as HistoryGitError).kind).toBe("cancelled");
      expect(temporaryEntries()).toEqual([]);
    } finally {
      watcher.close();
    }
  });
});
