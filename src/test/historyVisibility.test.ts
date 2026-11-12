import { describe, expect, it } from "vitest";
import type { HistoryCommit, HistoryData } from "../model/historyTypes";
import { filterVisibleOids, reachableFrom, VisibleCommitCache } from "../model/historyVisibility";

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
});
