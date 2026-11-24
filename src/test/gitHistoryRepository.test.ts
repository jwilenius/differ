import * as fs from "node:fs";
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
/** More commits than any fixture creates, so only the cap tests truncate. */
const MAX_COMMITS = 1_000;
/** `FIXTURE_DEFAULT_DATE` as `%aI` prints it: git 2.56+ writes UTC as `Z`, older versions as `+00:00`. */
const fixtureAuthoredDate = expect.stringMatching(/^2026-01-01T00:00:00(?:Z|\+00:00)$/);

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
    const history = await repository.loadHistory(MAX_COMMITS, signal);

    expect(history).toEqual({ commits: [], refs: [], head: null, isTruncated: false });
  });

  describe("head", () => {
    it("names the checked-out branch and its commit", async () => {
      commit("First");
      runFixtureGit(fixture.root, ["branch", "feature"]);
      const second = commit("Second");

      const history = await repository.loadHistory(MAX_COMMITS, signal);

      expect(history.head).toEqual({ oid: second, branch: "main" });
    });

    it("names a linked worktree's own branch while the main worktree is on another", async () => {
      const first = commit("First");
      const worktree = path.join(fixture.directory, "foo");
      runFixtureGit(fixture.root, ["worktree", "add", "-q", "-b", "jimw/foo-branch", worktree]);
      const foo = commitFiles(worktree, { message: "Foo", changes: [{ kind: "write", path: "foo.txt", content: "foo\n" }] });
      const linked = new GitHistoryRepository(worktree, fixtureGitEnvironment());

      const [main, other] = await Promise.all([
        repository.loadHistory(MAX_COMMITS, signal),
        linked.loadHistory(MAX_COMMITS, signal),
      ]);

      expect(main.head).toEqual({ oid: first, branch: "main" });
      expect(other.head).toEqual({ oid: foo, branch: "jimw/foo-branch" });
    });

    it("has no branch when detached", async () => {
      const first = commit("First");
      commit("Second");
      runFixtureGit(fixture.root, ["checkout", "-q", "--detach", first]);

      const history = await repository.loadHistory(MAX_COMMITS, signal);

      expect(history.head).toEqual({ oid: first, branch: null });
    });

    it("is absent on an unborn branch even when other branches exist", async () => {
      const first = commit("First");
      runFixtureGit(fixture.root, ["checkout", "-q", "--orphan", "fresh"]);

      const history = await repository.loadHistory(MAX_COMMITS, signal);

      expect(history.head).toBeNull();
      expect(history.commits.map((entry) => entry.oid)).toEqual([first]);
    });
  });

  it("labels branches, remote branches and tags, peeling annotated tags to their commit", async () => {
    const first = commit("First");
    runFixtureGit(fixture.root, ["tag", "light"]);
    runFixtureGit(fixture.root, ["branch", "feature"]);
    const second = commit("Second");
    runFixtureGit(fixture.root, ["tag", "-a", "-m", "Release", "v1.0"]);
    runFixtureGit(fixture.root, ["update-ref", "refs/remotes/origin/main", first]);
    runFixtureGit(fixture.root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    const history = await repository.loadHistory(MAX_COMMITS, signal);

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
    const attached = await repository.loadHistory(MAX_COMMITS, signal);
    runFixtureGit(fixture.root, ["checkout", "-q", "--detach", first]);

    const detached = await repository.loadHistory(MAX_COMMITS, signal);

    expect(attached.refs.some((ref) => ref.kind === "head")).toBe(false);
    expect(detached.refs).toContainEqual({ kind: "head", name: "HEAD", oid: first });
  });

  it("includes commits reachable only from a detached HEAD", async () => {
    commit("First");
    runFixtureGit(fixture.root, ["checkout", "-q", "--detach"]);
    const detachedOnly = commit("Detached only");

    const history = await repository.loadHistory(MAX_COMMITS, signal);

    expect(history.commits[0]?.oid).toBe(detachedOnly);
  });

  it("keeps authors with spaces and Unicode subjects intact", async () => {
    const oid = commit("Fix ünïcode — 日本語: a b\tc");
    const authorName = "Ada  King, Countess";
    runFixtureGit(fixture.root, ["commit", "-q", "--amend", "--no-edit", `--author=${authorName} <ada@example.com>`]);
    const amended = runFixtureGit(fixture.root, ["rev-parse", "HEAD"]).trim();

    const history = await repository.loadHistory(MAX_COMMITS, signal);

    expect(amended).not.toBe(oid);
    expect(history.commits).toEqual([{
      oid: amended,
      parents: [],
      author: authorName,
      authoredDate: fixtureAuthoredDate,
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

    const history = await repository.loadHistory(MAX_COMMITS, signal);
    const oids = history.commits.map((entry) => entry.oid);

    expect(history.commits[0]).toMatchObject({ oid: merge, parents: [main, side], subject: "Merge side" });
    expect(oids.indexOf(base)).toBe(oids.length - 1);
    expect(oids).toHaveLength(4);
  });

  describe("commit cap", () => {
    const cap = 3;

    function commitChain(count: number): readonly string[] {
      return Array.from({ length: count }, (_unused, index) => commit(`Commit ${index + 1}`));
    }

    it("loads every commit and reports no truncation when the history has exactly the cap", async () => {
      const oids = commitChain(cap);

      const history = await repository.loadHistory(cap, signal);

      expect(history.commits.map((entry) => entry.oid)).toEqual([...oids].reverse());
      expect(history.isTruncated).toBe(false);
    });

    it("keeps the newest commits and reports truncation when the history exceeds the cap", async () => {
      const oids = commitChain(cap + 1);

      const history = await repository.loadHistory(cap, signal);

      expect(history.commits.map((entry) => entry.oid)).toEqual([...oids].reverse().slice(0, cap));
      expect(history.isTruncated).toBe(true);
    });

    it("keeps a recent branch forked before the cut instead of only the deepest line of history", async () => {
      commit("Base", "file.txt", "2026-01-01T00:00:00Z");
      runFixtureGit(fixture.root, ["branch", "side"]);
      const [, , , main07, main09] = ["04", "05", "06", "07", "09"].map((day) => commit(`Main ${day}`, "file.txt", `2026-01-${day}T00:00:00Z`));
      runFixtureGit(fixture.root, ["checkout", "-q", "side"]);
      const side08 = commit("Side 08", "side.txt", "2026-01-08T00:00:00Z");

      const history = await repository.loadHistory(cap, signal);

      expect(history.commits.map((entry) => entry.oid)).toEqual([main09, side08, main07]);
      expect(history.isTruncated).toBe(true);
    });

    it("keeps each branch's commits together when the whole history fits", async () => {
      const base = commit("Base", "file.txt", "2026-01-01T00:00:00Z");
      runFixtureGit(fixture.root, ["checkout", "-q", "-b", "side"]);
      const side1 = commit("Side 1", "side.txt", "2026-01-02T00:00:00Z");
      const side2 = commit("Side 2", "side.txt", "2026-01-04T00:00:00Z");
      runFixtureGit(fixture.root, ["checkout", "-q", "main"]);
      const main1 = commit("Main 1", "file.txt", "2026-01-03T00:00:00Z");
      const main2 = commit("Main 2", "file.txt", "2026-01-05T00:00:00Z");

      const history = await repository.loadHistory(MAX_COMMITS, signal);

      const oids = history.commits.map((entry) => entry.oid);
      expect(Math.abs(oids.indexOf(side1) - oids.indexOf(side2))).toBe(1);
      expect(Math.abs(oids.indexOf(main1) - oids.indexOf(main2))).toBe(1);
      expect(oids.at(-1)).toBe(base);
    });

    function tracedGitCalls(): { readonly repository: GitHistoryRepository; readonly calls: () => readonly string[] } {
      const tracePath = path.join(fixture.directory, "git-trace.log");
      const traced = new GitHistoryRepository(fixture.root, { ...fixtureGitEnvironment(), GIT_TRACE: tracePath });
      const calls = (): readonly string[] => fs.readFileSync(tracePath, "utf8").split("\n").filter((line) => / git (log|rev-list) /.test(line));
      return { repository: traced, calls };
    }

    it("counts at most one commit more than the cap, then reads only the capped log", async () => {
      commitChain(cap + 2);
      const traced = tracedGitCalls();

      await traced.repository.loadHistory(cap, signal);

      const [count, log, ...rest] = traced.calls();
      expect(count).toMatch(/ git rev-list --count /);
      expect(count).toContain(`--max-count=${cap + 1}`);
      expect(log).toMatch(/ git log .*--date-order /);
      expect(log).toContain(`--max-count=${cap} `);
      expect(rest).toEqual([]);
    });

    it("reads the log once when the whole history fits under the cap", async () => {
      commitChain(cap);
      const traced = tracedGitCalls();

      await traced.repository.loadHistory(cap, signal);

      const logCalls = traced.calls().filter((line) => / git log /.test(line));
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]).toContain("--topo-order");
    });
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
        authoredDate: fixtureAuthoredDate,
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

  describe("readBranchCommits", () => {
    /** Makes `origin` a remote whose branches map to `refs/remotes/origin/*`, without fetching. */
    function addOriginRemote(): void {
      runFixtureGit(fixture.root, ["config", "remote.origin.url", fixture.root]);
      runFixtureGit(fixture.root, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    }

    function track(branch: string, remoteBranch: string): void {
      runFixtureGit(fixture.root, ["config", `branch.${branch}.remote`, "origin"]);
      runFixtureGit(fixture.root, ["config", `branch.${branch}.merge`, `refs/heads/${remoteBranch}`]);
    }

    function startFeature(): readonly string[] {
      runFixtureGit(fixture.root, ["checkout", "-q", "-b", "feature"]);
      const first = commit("Feature one", "feature.txt");
      return [commit("Feature two", "feature.txt"), first];
    }

    it("lists the commits a branch has beyond local main, newest first", async () => {
      commit("Base");
      const featureOids = startFeature();

      const result = await repository.readBranchCommits("refs/heads/feature", signal);

      expect(result).toEqual({ kind: "commits", branch: "feature", base: "main", isUpstream: false, oids: featureOids });
    });

    it("takes the default branch from origin/HEAD before local main", async () => {
      const base = commit("Base");
      runFixtureGit(fixture.root, ["update-ref", "refs/remotes/origin/develop", base]);
      runFixtureGit(fixture.root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
      const featureOids = startFeature();
      runFixtureGit(fixture.root, ["update-ref", "refs/heads/main", featureOids[1]!]);

      const result = await repository.readBranchCommits("refs/heads/feature", signal);

      expect(result).toMatchObject({ kind: "commits", base: "origin/develop", oids: featureOids });
    });

    it("skips an origin/HEAD whose branch is gone", async () => {
      commit("Base");
      runFixtureGit(fixture.root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone"]);
      const featureOids = startFeature();

      const result = await repository.readBranchCommits("refs/heads/feature", signal);

      expect(result).toMatchObject({ kind: "commits", base: "main", oids: featureOids });
    });

    it("falls back to master, and reports when neither main nor master exists", async () => {
      commit("Base");
      runFixtureGit(fixture.root, ["branch", "-m", "master"]);
      const featureOids = startFeature();
      expect(await repository.readBranchCommits("refs/heads/feature", signal)).toMatchObject({ base: "master", oids: featureOids });

      runFixtureGit(fixture.root, ["branch", "-m", "master", "trunk"]);

      expect(await repository.readBranchCommits("refs/heads/feature", signal)).toEqual({ kind: "noDefaultBranch", branch: "feature" });
    });

    it("lists the default branch's commits its upstream lacks", async () => {
      const pushed = commit("Pushed");
      const unpushed = commit("Not pushed");
      addOriginRemote();
      runFixtureGit(fixture.root, ["update-ref", "refs/remotes/origin/main", pushed]);
      runFixtureGit(fixture.root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      track("main", "main");

      const result = await repository.readBranchCommits("refs/heads/main", signal);

      expect(result).toEqual({ kind: "commits", branch: "main", base: "origin/main", isUpstream: true, oids: [unpushed] });
    });

    it("reports a default branch without an upstream or with a deleted one", async () => {
      const base = commit("Base");
      expect(await repository.readBranchCommits("refs/heads/main", signal)).toEqual({ kind: "noUpstream", branch: "main" });

      addOriginRemote();
      track("main", "main");
      expect(await repository.readBranchCommits("refs/heads/main", signal)).toEqual({ kind: "noUpstream", branch: "main" });

      runFixtureGit(fixture.root, ["update-ref", "refs/remotes/origin/main", base]);
      runFixtureGit(fixture.root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      const remoteResult = await repository.readBranchCommits("refs/remotes/origin/main", signal);
      expect(remoteResult).toEqual({ kind: "noUpstream", branch: "origin/main" });
    });

    it("compares a feature branch tracking origin's default branch with that branch, not as unpushed", async () => {
      const base = commit("Base");
      addOriginRemote();
      runFixtureGit(fixture.root, ["update-ref", "refs/remotes/origin/main", base]);
      runFixtureGit(fixture.root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      const featureOids = startFeature();
      track("feature", "main");

      const result = await repository.readBranchCommits("refs/heads/feature", signal);

      expect(result).toEqual({ kind: "commits", branch: "feature", base: "origin/main", isUpstream: false, oids: featureOids });
    });

    it("reads a detached HEAD's commits and an empty list for a branch merged into main", async () => {
      commit("Base");
      const featureOids = startFeature();
      runFixtureGit(fixture.root, ["checkout", "-q", "--detach"]);
      expect(await repository.readBranchCommits("HEAD", signal)).toMatchObject({ branch: "HEAD", oids: featureOids });

      runFixtureGit(fixture.root, ["update-ref", "refs/heads/main", featureOids[0]!]);

      expect(await repository.readBranchCommits("refs/heads/feature", signal)).toMatchObject({ kind: "commits", oids: [] });
    });

    it("rejects a name that is not a full ref", async () => {
      commit("Base");

      await expect(repository.readBranchCommits("--all", signal)).rejects.toThrow(HistoryRevisionError);
    });
  });

  describe("readIndexPath", () => {
    it("names the index of the main and of a linked worktree", async () => {
      commit("First");
      const linked = path.join(fixture.directory, "linked");
      runFixtureGit(fixture.root, ["worktree", "add", "-q", "--detach", linked]);
      const linkedRepository = new GitHistoryRepository(linked, fixtureGitEnvironment());

      const main = await repository.readIndexPath(signal);
      const linkedIndex = await linkedRepository.readIndexPath(signal);

      expect(fs.realpathSync(main)).toBe(fs.realpathSync(path.join(fixture.root, ".git", "index")));
      expect(fs.realpathSync(linkedIndex)).toBe(fs.realpathSync(path.join(fixture.root, ".git", "worktrees", "linked", "index")));
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
