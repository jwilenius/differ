import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHistoryRepository, HistoryRevisionError } from "../git/gitHistoryRepository";
import { HistoryComparisonError, resolveHistoryComparison } from "../git/historyComparisonResolver";
import type { HistoryComparisonResolution, ReplayTree } from "../git/historyComparisonResolver";
import type { BaseSelection, ComparisonRequest, MainlineChoice } from "../model/historyTypes";
import {
  commitFiles,
  createHistoryRepository,
  disposeHistoryRepository,
  fixtureGitEnvironment,
  runFixtureGit,
} from "./gitHistoryFixture";
import type { HistoryRepositoryFixture } from "./gitHistoryFixture";

const signal = new AbortController().signal;
const AUTOMATIC: BaseSelection = { kind: "automatic" };

describe("resolveHistoryComparison", () => {
  let fixture: HistoryRepositoryFixture;

  beforeEach(() => {
    fixture = createHistoryRepository();
  });

  afterEach(() => {
    disposeHistoryRepository(fixture);
  });

  function commit(message: string, date?: string): string {
    const change = { kind: "write", path: `${message}.txt`, content: `${message}\n` } as const;
    return commitFiles(fixture.root, { message, changes: [change], ...(date ? { date } : {}) });
  }

  function git(...args: string[]): string {
    return runFixtureGit(fixture.root, args).trim();
  }

  function treeOf(oid: string): string {
    return git("rev-parse", `${oid}^{tree}`);
  }

  function commitTree(oid: string): ReplayTree {
    return { kind: "commit", oid, treeOid: treeOf(oid) };
  }

  function resolve(
    selectedOids: readonly string[],
    base: BaseSelection = AUTOMATIC,
    mainlines: readonly MainlineChoice[] = [],
    root = fixture.root,
  ): Promise<HistoryComparisonResolution> {
    const request: ComparisonRequest = { selectedOids, base, mainlines };
    return resolveHistoryComparison(new GitHistoryRepository(root, fixtureGitEnvironment()), request, signal);
  }

  /** Main: A - B - C - D. */
  function linearHistory(): readonly [string, string, string, string] {
    return [commit("A"), commit("B"), commit("C"), commit("D")];
  }

  /** Main: A - B; side: A - S; M merges side into main with parents [B, S]. */
  function mergeHistory(): { readonly a: string; readonly b: string; readonly s: string; readonly m: string } {
    const a = commit("A");
    git("checkout", "-q", "-b", "side");
    const s = commit("S");
    git("checkout", "-q", "main");
    const b = commit("B");
    git("merge", "-q", "--no-ff", "-m", "M", "side");
    return { a, b, s, m: git("rev-parse", "HEAD") };
  }

  it("uses the parent of the single earliest selection as base and skips unselected commits", async () => {
    const [a, b, c, d] = linearHistory();

    const resolution = await resolve([d, b]);

    expect(resolution).toEqual({
      kind: "resolved",
      base: { kind: "commit", oid: a, subject: "A" },
      baseTree: commitTree(a),
      steps: [
        { oid: b, treeOid: treeOf(b), parent: commitTree(a) },
        { oid: d, treeOid: treeOf(d), parent: commitTree(c) },
      ],
    });
  });

  it("starts from the empty tree when a root commit is selected", async () => {
    const [a, b] = linearHistory();

    const resolution = await resolve([b, a]);

    expect(resolution).toMatchObject({
      base: { kind: "emptyTree" },
      baseTree: { kind: "emptyTree" },
      steps: [{ oid: a, parent: { kind: "emptyTree" } }, { oid: b, parent: commitTree(a) }],
    });
  });

  it("orders by ancestry regardless of selection order or skewed dates", async () => {
    const a = commit("A", "2026-03-01T00:00:00Z");
    const b = commit("B", "2026-02-01T00:00:00Z");
    const c = commit("C", "2026-04-01T00:00:00Z");
    const d = commit("D", "2026-01-01T00:00:00Z");

    const forward = await resolve([b, c, d]);
    const reversed = await resolve([d, c, b, d]);

    expect(reversed).toEqual(forward);
    expect(forward.kind === "resolved" && forward.steps.map((step) => step.oid)).toEqual([b, c, d]);
    expect(forward).toMatchObject({ base: { kind: "commit", oid: a } });
  });

  it("needs an explicit base for sibling minima and accepts a pinned one", async () => {
    const a = commit("A");
    git("checkout", "-q", "-b", "left");
    const left = commit("Left");
    git("checkout", "-q", "-b", "right", a);
    const right = commit("Right");

    const automatic = await resolve([left, right]);
    const pinned = await resolve([left, right], { kind: "pinned", oid: a, label: "main" });

    expect(automatic.kind).toBe("needsBase");
    expect(automatic.kind === "needsBase" && [...automatic.minimumOids].sort()).toEqual([left, right].sort());
    expect(pinned).toMatchObject({
      kind: "resolved",
      base: { kind: "commit", oid: a, subject: "A" },
      baseTree: commitTree(a),
    });
    const parents = pinned.kind === "resolved" ? pinned.steps.map((step) => step.parent) : [];
    expect(parents).toEqual([commitTree(a), commitTree(a)]);
  });

  it("keeps a pinned base even when it differs from the Automatic one", async () => {
    const [a, , c, d] = linearHistory();

    const resolution = await resolve([c, d], { kind: "pinned", oid: a, label: a.slice(0, 7) });

    expect(resolution).toMatchObject({ base: { oid: a }, steps: [{ oid: c }, { oid: d, parent: commitTree(c) }] });
  });

  it("takes a merge's patch against parent 1 by default and against a chosen parent", async () => {
    const { b, s, m } = mergeHistory();

    const byDefault = await resolve([m]);
    const bySide = await resolve([m], AUTOMATIC, [{ oid: m, parentNumber: 2 }]);

    expect(byDefault).toMatchObject({ base: { oid: b }, steps: [{ oid: m, parent: commitTree(b) }] });
    expect(bySide).toMatchObject({ base: { oid: s, subject: "S" }, steps: [{ oid: m, parent: commitTree(s) }] });
  });

  it("counts ancestry through every merge parent when finding the earliest selection", async () => {
    const { a, s, m } = mergeHistory();

    const resolution = await resolve([m, s]);

    expect(resolution).toMatchObject({ base: { oid: a }, steps: [{ oid: s }, { oid: m }] });
  });

  it.each([
    { parentNumber: 0 },
    { parentNumber: 3 },
    { parentNumber: 1.5 },
  ])("rejects merge parent $parentNumber", async ({ parentNumber }) => {
    const { m } = mergeHistory();

    const resolution = resolve([m], AUTOMATIC, [{ oid: m, parentNumber }]);

    await expect(resolution).rejects.toMatchObject({ kind: "invalidMainline" });
  });

  it("rejects mainline choices for unselected commits and duplicate choices", async () => {
    const { b, m } = mergeHistory();

    const unselected = [{ oid: m, parentNumber: 1 }];
    const duplicate = [{ oid: m, parentNumber: 1 }, { oid: m, parentNumber: 2 }];

    await expect(resolve([b], AUTOMATIC, unselected)).rejects.toMatchObject({ kind: "invalidMainline" });
    await expect(resolve([m], AUTOMATIC, duplicate)).rejects.toMatchObject({ kind: "invalidMainline" });
  });

  it("rejects an empty selection and commits that are not in the repository", async () => {
    linearHistory();

    await expect(resolve([])).rejects.toBeInstanceOf(HistoryComparisonError);
    await expect(resolve(["f".repeat(40)])).rejects.toBeInstanceOf(HistoryRevisionError);
  });

  it("refuses to treat a shallow boundary as a root, even with an explicit base", async () => {
    linearHistory();
    const clone = path.join(fixture.directory, "shallow");
    runFixtureGit(fixture.directory, ["clone", "-q", "--depth", "2", `file://${fixture.root}`, clone]);
    const [d = "", c = ""] = runFixtureGit(clone, ["rev-list", "HEAD"]).trim().split("\n");
    const pinnedD: BaseSelection = { kind: "pinned", oid: d, label: "HEAD" };

    const insideBoundary = await resolve([d], AUTOMATIC, [], clone);

    expect(insideBoundary).toMatchObject({ base: { oid: c } });
    await expect(resolve([c, d], AUTOMATIC, [], clone)).rejects.toMatchObject({ kind: "shallowHistory" });
    await expect(resolve([c], pinnedD, [], clone)).rejects.toMatchObject({ kind: "shallowHistory" });
  });
});
