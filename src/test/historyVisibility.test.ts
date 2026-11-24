import { describe, expect, it } from "vitest";
import type { HistoryCommit, HistoryData } from "../model/historyTypes";
import { filterVisibleOids, reachableFrom, VisibleCommitCache, visibleWorkingChangeIds } from "../model/historyVisibility";
import { STAGED_CHANGES_ID, UNSTAGED_CHANGES_ID } from "../model/historyWorkingChanges";
import type { WorkingChangeSummary } from "../model/historyWorkingChanges";

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const F1 = "f".repeat(40);

function commit(oid: string, parents: readonly string[], subject: string): HistoryCommit {
  return { oid, parents, author: "Ann", authoredDate: "2026-01-01T00:00:00Z", subject };
}

/** feature (F1) and main (C3) both grow from C1. */
const HISTORY: HistoryData = {
  commits: [
    commit(F1, [C1], "Feature work"),
    commit(C3, [C2], "Third change"),
    commit(C2, [C1], "Second change"),
    commit(C1, [], "Initial import"),
  ],
  refs: [],
  head: null,
  isTruncated: false,
};

const ALL = { search: "", branchOid: null };

describe("filterVisibleOids", () => {
  it("lists every loaded commit in order without filters", () => {
    expect(filterVisibleOids(HISTORY, ALL)).toEqual([F1, C3, C2, C1]);
    expect(filterVisibleOids(null, ALL)).toEqual([]);
  });

  it("matches subjects case-insensitively and hashes literally, ignoring surrounding space", () => {
    expect(filterVisibleOids(HISTORY, { search: "  CHANGE ", branchOid: null })).toEqual([C3, C2]);
    expect(filterVisibleOids(HISTORY, { search: "333", branchOid: null })).toEqual([C3]);
    expect(filterVisibleOids(HISTORY, { search: ".*", branchOid: null })).toEqual([]);
  });

  it("keeps only ancestors of the branch tip and combines that with search", () => {
    expect(filterVisibleOids(HISTORY, { search: "", branchOid: F1 })).toEqual([F1, C1]);
    expect(filterVisibleOids(HISTORY, { search: "initial", branchOid: C3 })).toEqual([C1]);
  });
});

describe("reachableFrom", () => {
  it("walks parents within loaded commits and is empty for an unknown tip", () => {
    expect([...reachableFrom(HISTORY.commits, C3)].sort()).toEqual([C1, C2, C3]);
    expect(reachableFrom(HISTORY.commits, "9".repeat(40)).size).toBe(0);
  });
});

describe("VisibleCommitCache", () => {
  it("returns the same result while history and filters are unchanged", () => {
    const cache = new VisibleCommitCache();

    const first = cache.visibleOids(HISTORY, { search: "change", branchOid: C3 });
    const second = cache.visibleOids(HISTORY, { search: "change", branchOid: C3 });

    expect(first).toEqual([C3, C2]);
    expect(second).toBe(first);
  });

  it("recomputes for new filters or a reloaded history", () => {
    const cache = new VisibleCommitCache();
    const first = cache.visibleOids(HISTORY, { search: "", branchOid: F1 });

    const searched = cache.visibleOids(HISTORY, { search: "feature", branchOid: F1 });
    const reloaded = cache.visibleOids({ ...HISTORY, commits: HISTORY.commits.slice(1) }, { search: "feature", branchOid: F1 });

    expect(first).toEqual([F1, C1]);
    expect(searched).toEqual([F1]);
    expect(reloaded).toEqual([]);
  });

  it("counts selected commits the filters hide, including ones no longer loaded", () => {
    const cache = new VisibleCommitCache();
    const gone = "9".repeat(40);

    expect(cache.hiddenCount(HISTORY, ALL, [C1, F1])).toBe(0);
    expect(cache.hiddenCount(HISTORY, ALL, [C1, gone])).toBe(1);
    expect(cache.hiddenCount(HISTORY, { search: "", branchOid: F1 }, [C1, C2, C3, F1])).toBe(2);
    expect(cache.hiddenCount(HISTORY, { search: "change", branchOid: null }, [C2, F1])).toBe(1);
    expect(cache.hiddenCount(HISTORY, { search: "change", branchOid: null }, [])).toBe(0);
  });
});

describe("visibleWorkingChangeIds", () => {
  const CHANGES: WorkingChangeSummary = { staged: 1, unstaged: 2, untracked: 0, conflicted: 0, isTruncated: false };
  /** `feature` (F1) is checked out; `main` (C3) is not. */
  const CHECKED_OUT: HistoryData = {
    ...HISTORY,
    refs: [{ kind: "localBranch", name: "feature", oid: F1 }, { kind: "localBranch", name: "main", oid: C3 }],
    head: { oid: F1, branch: "feature" },
  };

  it("lists the rows with changes Unstaged first", () => {
    const ids = visibleWorkingChangeIds(CHECKED_OUT, CHANGES, "", null);

    expect(ids).toEqual([UNSTAGED_CHANGES_ID, STAGED_CHANGES_ID]);
  });

  it("keeps the rows under the checked-out branch filter and hides them under any other", () => {
    const feature = visibleWorkingChangeIds(CHECKED_OUT, CHANGES, "", { ref: "refs/heads/feature", tipOid: F1 });
    const main = visibleWorkingChangeIds(CHECKED_OUT, CHANGES, "", { ref: "refs/heads/main", tipOid: C3 });

    expect(feature).toEqual([UNSTAGED_CHANGES_ID, STAGED_CHANGES_ID]);
    expect(main).toEqual([]);
  });

  it("shows only rows whose label matches the search", () => {
    const unstaged = visibleWorkingChangeIds(CHECKED_OUT, CHANGES, "  UNSTAGED ", null);
    const both = visibleWorkingChangeIds(CHECKED_OUT, CHANGES, "changes", null);
    const none = visibleWorkingChangeIds(CHECKED_OUT, CHANGES, "feature", null);

    expect(unstaged).toEqual([UNSTAGED_CHANGES_ID]);
    expect(both).toEqual([UNSTAGED_CHANGES_ID, STAGED_CHANGES_ID]);
    expect(none).toEqual([]);
  });

  it("omits rows without changes", () => {
    const ids = visibleWorkingChangeIds(CHECKED_OUT, { ...CHANGES, staged: 0 }, "", null);

    expect(ids).toEqual([UNSTAGED_CHANGES_ID]);
  });
});
