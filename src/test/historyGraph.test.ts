import { describe, expect, it } from "vitest";
import { HistoryGraphLayout, visibleGraphRows } from "../model/historyGraph";
import type { GraphSegment, HistoryGraphRow, VisibleGraphRow } from "../model/historyGraph";
import type { HistoryCommit } from "../model/historyTypes";

function commit(oid: string, ...parents: string[]): HistoryCommit {
  return { oid, parents, author: "A", authoredDate: "2026-01-01T00:00:00+00:00", subject: oid };
}

function indicesTo(count: number): readonly number[] {
  return Array.from({ length: count }, (_unused, index) => index);
}

/** Every row of the graph, laid out in one request. */
function layOutAll(commits: readonly HistoryCommit[]): readonly HistoryGraphRow[] {
  return new HistoryGraphLayout(commits).rowsAt(indicesTo(commits.length));
}

function filteredRows(commits: readonly HistoryCommit[], visibleOids: readonly string[], limit = visibleOids.length): readonly VisibleGraphRow[] {
  return visibleGraphRows(new HistoryGraphLayout(commits), visibleOids, limit);
}

/**
 * A deterministic tangle ordered children before parents: forks, merges, octopus merges, roots and parents
 * outside the loaded commits.
 */
function tangledHistory(count: number): readonly HistoryCommit[] {
  let seed = 7;
  const next = (bound: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % bound;
  };
  return Array.from({ length: count }, (_unused, index) => {
    const parentCount = index === count - 1 ? 0 : [1, 1, 1, 2, 2, 3, 0][next(7)]!;
    const parents = Array.from({ length: parentCount }, () => {
      const isUnloaded = next(9) === 0;
      return isUnloaded ? `gone${next(1_000)}` : `c${Math.min(count - 1, index + 1 + next(12))}`;
    });
    return commit(`c${index}`, ...new Set(parents));
  });
}

function rowOf(rows: readonly HistoryGraphRow[], oid: string): HistoryGraphRow {
  const row = rows.find((candidate) => candidate.oid === oid);
  if (!row) {
    throw new Error(`no row ${oid}`);
  }
  return row;
}

function ends(segments: readonly GraphSegment[]): readonly (readonly [number, number])[] {
  return segments.map((segment) => [segment.from, segment.to] as const);
}

describe("graph rows", () => {
  it("draws a root as a node with no lines", () => {
    const [root] = layOutAll([commit("r")]);

    expect(root).toMatchObject({ oid: "r", lane: 0, upper: [], lower: [], width: 1 });
  });

  it("keeps a linear chain in one lane and stops at the root", () => {
    const rows = layOutAll([commit("c", "b"), commit("b", "a"), commit("a")]);

    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(ends(rowOf(rows, "c").upper)).toEqual([]);
    expect(ends(rowOf(rows, "c").lower)).toEqual([[0, 0]]);
    expect(ends(rowOf(rows, "b").upper)).toEqual([[0, 0]]);
    expect(ends(rowOf(rows, "a").lower)).toEqual([]);
    expect(new Set(rows.map((row) => row.color)).size).toBe(1);
  });

  it("joins a fork's branches into their shared parent", () => {
    const rows = layOutAll([commit("x", "base"), commit("y", "base"), commit("base")]);

    expect(rowOf(rows, "x").lane).toBe(0);
    expect(rowOf(rows, "y").lane).toBe(1);
    expect(ends(rowOf(rows, "y").upper)).toEqual([[0, 0]]);
    expect(ends(rowOf(rows, "y").lower)).toEqual([[0, 0], [1, 0]]);
    expect(rowOf(rows, "base")).toMatchObject({ lane: 0, upper: [{ from: 0, to: 0 }], lower: [] });
  });

  it("converges a two-parent merge from both parent lanes", () => {
    const rows = layOutAll([commit("m", "p1", "p2"), commit("p1", "b"), commit("p2", "b"), commit("b")]);

    const merge = rowOf(rows, "m");
    expect(ends(merge.lower)).toEqual([[0, 0], [0, 1]]);
    expect(rowOf(rows, "p1").lane).toBe(0);
    expect(rowOf(rows, "p2").lane).toBe(1);
    expect(ends(rowOf(rows, "p2").lower)).toEqual([[0, 0], [1, 0]]);
    expect(rowOf(rows, "b").lane).toBe(0);
    expect(rowOf(rows, "p2").color).not.toBe(merge.color);
  });

  it("gives each octopus parent its own lane", () => {
    const rows = layOutAll([commit("o", "a", "b", "c"), commit("a"), commit("b"), commit("c")]);

    expect(ends(rowOf(rows, "o").lower)).toEqual([[0, 0], [0, 1], [0, 2]]);
    expect(["a", "b", "c"].map((oid) => rowOf(rows, oid).lane)).toEqual([0, 0, 0]);
    expect(ends(rowOf(rows, "a").upper)).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(ends(rowOf(rows, "a").lower)).toEqual([[1, 0], [2, 1]]);
  });

  it("reuses an existing lane when a merge parent is already expected", () => {
    const rows = layOutAll([commit("t", "a"), commit("m", "x", "a"), commit("x", "a"), commit("a")]);

    expect(ends(rowOf(rows, "m").lower)).toEqual([[0, 0], [1, 1], [1, 0]]);
    expect(rowOf(rows, "a")).toMatchObject({ lane: 0 });
    expect(ends(rowOf(rows, "a").upper)).toEqual([[0, 0]]);
  });

  it("lays out disconnected histories side by side without linking them", () => {
    const rows = layOutAll([commit("a2", "a1"), commit("b2", "b1"), commit("a1"), commit("b1")]);

    expect(rowOf(rows, "b2").lane).toBe(1);
    expect(ends(rowOf(rows, "a1").lower)).toEqual([[1, 0]]);
    expect(rowOf(rows, "b1")).toMatchObject({ lane: 0, lower: [] });
  });

  it("ends lanes for parents outside the loaded commits in a stub straight down", () => {
    const [row] = layOutAll([commit("a", "missing")]);

    expect(row?.lower).toEqual([]);
    expect(row?.cuts).toEqual([{ from: 0, to: 0, color: row?.color }]);
    expect(row?.width).toBe(1);
  });

  it("angles stubs for unloaded parents beside the lane to a loaded parent, without widening the row", () => {
    const rows = layOutAll([commit("m", "p1", "gone1", "gone2"), commit("p1")]);
    const merge = rowOf(rows, "m");

    expect(ends(merge.lower)).toEqual([[0, 0]]);
    expect(ends(merge.cuts)).toEqual([[0, 1], [0, 2]]);
    expect(merge.width).toBe(1);
  });

  it("draws no stubs for true roots or for parents that are loaded", () => {
    const rows = layOutAll([commit("m", "p1", "p2"), commit("p2", "r"), commit("p1", "r"), commit("r")]);

    expect(rows.flatMap((row) => row.cuts)).toEqual([]);
  });

  it("produces identical output for repeated input", () => {
    const commits = [commit("m", "p1", "p2"), commit("p2", "b"), commit("p1", "b"), commit("b")];

    expect(JSON.stringify(layOutAll(commits))).toBe(JSON.stringify(layOutAll(commits)));
  });
});

describe("HistoryGraphLayout", () => {
  const commits = tangledHistory(400);
  const full = layOutAll(commits);

  it("lays out requested rows exactly as the whole graph at once, in any request order", () => {
    const layout = new HistoryGraphLayout(commits);
    const requests = [indicesTo(50), indicesTo(120), [3, 77, 78, 250, 399], [10, 11], indicesTo(400), [0]];

    for (const request of requests) {
      expect(layout.rowsAt(request)).toEqual(request.map((index) => full[index]));
    }
  });

  it("ends parent lines for commits outside the loaded history with stubs in the tangle", () => {
    expect(full.some((row) => row.cuts.length > 0)).toBe(true);
    expect(full.some((row) => row.lower.length > 1)).toBe(true);
  });

  it("lays out no row past the last one requested", () => {
    const layout = new HistoryGraphLayout(commits);

    layout.rowsAt(indicesTo(50));

    expect(layout.laidOutRowCount).toBe(50);
  });

  it("reuses the last request's rows and continues from the last laid-out row", () => {
    const layout = new HistoryGraphLayout(commits);
    layout.rowsAt(indicesTo(50));

    layout.rowsAt(indicesTo(50));
    expect(layout.laidOutRowCount).toBe(50);

    layout.rowsAt(indicesTo(100));
    expect(layout.laidOutRowCount).toBe(100);
  });

  it("walks again only for an earlier row it no longer keeps", () => {
    const layout = new HistoryGraphLayout(commits);
    layout.rowsAt([20, 30]);
    expect(layout.laidOutRowCount).toBe(31);

    layout.rowsAt([5]);

    expect(layout.laidOutRowCount).toBe(37);
  });

  it("walks to an earlier row from the nearest lane state it kept, not from the top", () => {
    const layout = new HistoryGraphLayout(commits);
    layout.rowsAt([399]);

    const rows = layout.rowsAt([200, 380]);

    expect(rows).toEqual([full[200], full[380]]);
    expect(layout.laidOutRowCount - 400).toBeLessThan(200);
  });

  it("finds rows by OID and knows how many there are", () => {
    const layout = new HistoryGraphLayout(commits);

    expect(layout.rowCount).toBe(400);
    expect(layout.indexOf("c42")).toBe(42);
    expect(layout.indexOf("gone1")).toBeUndefined();
  });
});

describe("visibleGraphRows", () => {
  const chain = [commit("d", "c"), commit("c", "b"), commit("b", "a"), commit("a")];
  const rows = layOutAll(chain);

  it("marks gaps where hidden rows sit between visible ones", () => {
    const visible = filteredRows(chain, ["d", "a"]);

    expect(visible.map((entry) => [entry.row.oid, entry.hasHiddenAbove, entry.hasHiddenBelow])).toEqual([
      ["d", false, true],
      ["a", true, false],
    ]);
  });

  it("keeps original lanes and segments without inventing edges", () => {
    const visible = filteredRows(chain, ["c"]);

    expect(visible).toEqual([{ row: rowOf(rows, "c"), hasHiddenAbove: true, hasHiddenBelow: true }]);
  });

  it("marks no gaps when every row is visible", () => {
    const visible = filteredRows(chain, ["d", "c", "b", "a"]);

    expect(visible.map((entry) => entry.row.oid)).toEqual(["d", "c", "b", "a"]);
    expect(visible.some((entry) => entry.hasHiddenAbove || entry.hasHiddenBelow)).toBe(false);
  });

  it("takes the gap below the last shown row from the next visible row beyond the limit", () => {
    const cut = filteredRows(chain, ["d", "c", "a"], 2);
    const joined = filteredRows(chain, ["d", "c", "b"], 2);

    expect(cut.map((entry) => [entry.row.oid, entry.hasHiddenBelow])).toEqual([["d", false], ["c", true]]);
    expect(joined.map((entry) => [entry.row.oid, entry.hasHiddenBelow])).toEqual([["d", false], ["c", false]]);
  });

  it("matches the whole graph filtered for every page of a filtered tangle", () => {
    const commits = tangledHistory(400);
    const all = layOutAll(commits);
    const visibleOids = commits.filter((_entry, index) => index % 3 !== 1).map((entry) => entry.oid);
    const layout = new HistoryGraphLayout(commits);

    for (const limit of [20, 60, visibleOids.length]) {
      const visible = visibleGraphRows(layout, visibleOids, limit);
      const expected = visibleOids.slice(0, limit).map((oid, position) => {
        const index = all.findIndex((row) => row.oid === oid);
        const previous = position === 0 ? -1 : all.findIndex((row) => row.oid === visibleOids[position - 1]);
        const nextOid = visibleOids[position + 1];
        const next = nextOid === undefined ? all.length : all.findIndex((row) => row.oid === nextOid);
        return { row: all[index], hasHiddenAbove: index - previous > 1, hasHiddenBelow: next - index > 1 };
      });
      expect(visible).toEqual(expected);
    }
  });

  it("lays out rows only through the last shown one", () => {
    const commits = tangledHistory(400);
    const layout = new HistoryGraphLayout(commits);

    const visible = visibleGraphRows(layout, ["c4", "c9", "c30", "c31"], 2);

    expect(visible.map((entry) => entry.row.oid)).toEqual(["c4", "c9"]);
    expect(visible[1]?.hasHiddenBelow).toBe(true);
    expect(layout.laidOutRowCount).toBe(10);
  });

  it("rejects visible OIDs that are not in the layout", () => {
    const layout = new HistoryGraphLayout(tangledHistory(10));

    expect(() => visibleGraphRows(layout, ["c4", "unknown"], 5)).toThrow(/unknown/);
  });
});
