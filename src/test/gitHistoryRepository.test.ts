import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHistoryRepository, HistoryRevisionError } from "../git/gitHistoryRepository";
import {
  commitFiles,
  createHistoryRepository,
  disposeHistoryRepository,
  fixtureGitEnvironment,
  runFixtureGit,
} from "./gitHistoryFixture";
import type { HistoryRepositoryFixture } from "./gitHistoryFixture";

const signal = new AbortController().signal;

describe("GitHistoryRepository", () => {
  let fixture: HistoryRepositoryFixture;
  let repository: GitHistoryRepository;

  beforeEach(() => {
    fixture = createHistoryRepository();
    repository = new GitHistoryRepository(fixture.root, fixtureGitEnvironment());
  });

  afterEach(() => {
    disposeHistoryRepository(fixture);
  });

  function commit(message: string, file = "file.txt", date?: string): string {
    const change = { kind: "write", path: file, content: `${message}\n` } as const;
    return commitFiles(fixture.root, { message, changes: [change], ...(date ? { date } : {}) });
  }

  it("returns an empty history for an unborn repository", async () => {
    const history = await repository.loadHistory(signal);

    expect(history).toEqual({ commits: [], refs: [] });
  });

  it("labels branches, remote branches and tags, peeling annotated tags to their commit", async () => {
    const first = commit("First");
    runFixtureGit(fixture.root, ["tag", "light"]);
    runFixtureGit(fixture.root, ["branch", "feature"]);
    const second = commit("Second");
    runFixtureGit(fixture.root, ["tag", "-a", "-m", "Release", "v1.0"]);
    runFixtureGit(fixture.root, ["update-ref", "refs/remotes/origin/main", first]);
    runFixtureGit(fixture.root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    const history = await repository.loadHistory(signal);

    expect(history.refs).toEqual(expect.arrayContaining([
      { kind: "localBranch", name: "main", oid: second },
      { kind: "localBranch", name: "feature", oid: first },
      { kind: "remoteBranch", name: "origin/main", oid: first },
      { kind: "tag", name: "light", oid: first },
      { kind: "tag", name: "v1.0", oid: second },
    ]));
    expect(history.refs).toHaveLength(5);
    expect(history.commits.map((entry) => entry.oid)).toEqual([second, first]);
  });

  it("includes a detached HEAD but not an attached one", async () => {
    const first = commit("First");
    commit("Second");
    const attached = await repository.loadHistory(signal);
    runFixtureGit(fixture.root, ["checkout", "-q", "--detach", first]);

    const detached = await repository.loadHistory(signal);

    expect(attached.refs.some((ref) => ref.kind === "head")).toBe(false);
    expect(detached.refs).toContainEqual({ kind: "head", name: "HEAD", oid: first });
  });

  it("includes commits reachable only from a detached HEAD", async () => {
    commit("First");
    runFixtureGit(fixture.root, ["checkout", "-q", "--detach"]);
    const detachedOnly = commit("Detached only");

    const history = await repository.loadHistory(signal);

    expect(history.commits[0]?.oid).toBe(detachedOnly);
  });

  it("keeps authors with spaces and Unicode subjects intact", async () => {
    const oid = commit("Fix ünïcode — 日本語: a b\tc");
    const authorName = "Ada  King, Countess";
    runFixtureGit(fixture.root, ["commit", "-q", "--amend", "--no-edit", `--author=${authorName} <ada@example.com>`]);
    const amended = runFixtureGit(fixture.root, ["rev-parse", "HEAD"]).trim();

    const history = await repository.loadHistory(signal);

    expect(amended).not.toBe(oid);
    expect(history.commits).toEqual([{
      oid: amended,
      parents: [],
      author: authorName,
      authoredDate: "2026-01-01T00:00:00+00:00",
      subject: "Fix ünïcode — 日本語: a b\tc",
    }]);
  });

  it("lists real parents of a merge and orders children before parents despite skewed dates", async () => {
    const base = commit("Base", "base.txt", "2026-01-05T00:00:00Z");
    runFixtureGit(fixture.root, ["checkout", "-q", "-b", "side"]);
    const side = commit("Side", "side.txt", "2026-01-01T00:00:00Z");
    runFixtureGit(fixture.root, ["checkout", "-q", "main"]);
    const main = commit("Main", "main.txt", "2026-01-02T00:00:00Z");
    runFixtureGit(fixture.root, ["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
    const merge = runFixtureGit(fixture.root, ["rev-parse", "HEAD"]).trim();

    const history = await repository.loadHistory(signal);
    const oids = history.commits.map((entry) => entry.oid);

    expect(history.commits[0]).toMatchObject({ oid: merge, parents: [main, side], subject: "Merge side" });
    expect(oids.indexOf(base)).toBe(oids.length - 1);
    expect(oids).toHaveLength(4);
  });

  describe("resolveRef", () => {
    it("resolves branches, annotated tags and abbreviated hashes to full commits", async () => {
      const oid = commit("Only");
      runFixtureGit(fixture.root, ["tag", "-a", "-m", "Release", "v1.0"]);

      const byBranch = await repository.resolveRef("main", signal);
      const byTag = await repository.resolveRef("v1.0", signal);
      const byShortHash = await repository.resolveRef(oid.slice(0, 8), signal);

      expect(byBranch).toEqual({
        oid,
        parents: [],
        author: "Test Author",
        authoredDate: "2026-01-01T00:00:00+00:00",
        subject: "Only",
      });
      expect(byTag.oid).toBe(oid);
      expect(byShortHash.oid).toBe(oid);
    });

    it("stays pinned to the resolved commit when the branch moves", async () => {
      const first = commit("First");
      const pinned = await repository.resolveRef("main", signal);
      const second = commit("Second");

      const moved = await repository.resolveRef("main", signal);
      const [stillFirst] = await repository.readCommits([pinned.oid], signal);

      expect(pinned.oid).toBe(first);
      expect(moved.oid).toBe(second);
      expect(stillFirst?.subject).toBe("First");
    });

    it.each(["", "   ", "--all", "-x", "missing-branch", "HEAD^{tree}", "HEAD:file.txt"])(
      "rejects %j as a base",
      async (ref) => {
        commit("Only");

        await expect(repository.resolveRef(ref, signal)).rejects.toBeInstanceOf(HistoryRevisionError);
      },
    );
  });

  describe("readCommits", () => {
    it("rejects abbreviated, unknown and non-commit IDs", async () => {
      const oid = commit("Only");
      const tree = runFixtureGit(fixture.root, ["rev-parse", "HEAD^{tree}"]).trim();
      const unknown = "0".repeat(40);

      await expect(repository.readCommits([oid.slice(0, 8)], signal)).rejects.toBeInstanceOf(HistoryRevisionError);
      await expect(repository.readCommits([oid, unknown], signal)).rejects.toThrow(unknown);
      await expect(repository.readCommits([tree], signal)).rejects.toBeInstanceOf(HistoryRevisionError);
    });
  });

  describe("readShallowOids", () => {
    it("is empty for a complete repository and lists the boundary of a shallow clone", async () => {
      commit("First");
      commit("Second");
      const third = commit("Third");
      const clone = path.join(fixture.directory, "shallow");
      runFixtureGit(fixture.directory, ["clone", "-q", "--depth", "1", `file://${fixture.root}`, clone]);
      const shallowRepository = new GitHistoryRepository(clone, fixtureGitEnvironment());

      const complete = await repository.readShallowOids(signal);
      const shallow = await shallowRepository.readShallowOids(signal);

      expect([...complete]).toEqual([]);
      expect([...shallow]).toEqual([third]);
    });
  });
});
