import { describe, expect, it } from "vitest";
import { buildHistoryGraph, filterHistoryGraph } from "../model/historyGraph";
import type { GraphSegment, HistoryGraphRow } from "../model/historyGraph";
import type { HistoryCommit } from "../model/historyTypes";

function commit(oid: string, ...parents: string[]): HistoryCommit {
  return { oid, parents, author: "A", authoredDate: "2026-01-01T00:00:00+00:00", subject: oid };
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

describe("buildHistoryGraph", () => {
  it("draws a root as a node with no lines", () => {
    const [root] = buildHistoryGraph([commit("r")]);

    expect(root).toMatchObject({ oid: "r", lane: 0, upper: [], lower: [], width: 1 });
  });

  it("keeps a linear chain in one lane and stops at the root", () => {
    const rows = buildHistoryGraph([commit("c", "b"), commit("b", "a"), commit("a")]);

    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(ends(rowOf(rows, "c").upper)).toEqual([]);
    expect(ends(rowOf(rows, "c").lower)).toEqual([[0, 0]]);
    expect(ends(rowOf(rows, "b").upper)).toEqual([[0, 0]]);
    expect(ends(rowOf(rows, "a").lower)).toEqual([]);
    expect(new Set(rows.map((row) => row.color)).size).toBe(1);
  });

  it("joins a fork's branches into their shared parent", () => {
    const rows = buildHistoryGraph([commit("x", "base"), commit("y", "base"), commit("base")]);

    expect(rowOf(rows, "x").lane).toBe(0);
    expect(rowOf(rows, "y").lane).toBe(1);
    expect(ends(rowOf(rows, "y").upper)).toEqual([[0, 0]]);
    expect(ends(rowOf(rows, "y").lower)).toEqual([[0, 0], [1, 0]]);
    expect(rowOf(rows, "base")).toMatchObject({ lane: 0, upper: [{ from: 0, to: 0 }], lower: [] });
  });

  it("converges a two-parent merge from both parent lanes", () => {
    const rows = buildHistoryGraph([commit("m", "p1", "p2"), commit("p1", "b"), commit("p2", "b"), commit("b")]);

    const merge = rowOf(rows, "m");
    expect(ends(merge.lower)).toEqual([[0, 0], [0, 1]]);
    expect(rowOf(rows, "p1").lane).toBe(0);
    expect(rowOf(rows, "p2").lane).toBe(1);
    expect(ends(rowOf(rows, "p2").lower)).toEqual([[0, 0], [1, 0]]);
    expect(rowOf(rows, "b").lane).toBe(0);
    expect(rowOf(rows, "p2").color).not.toBe(merge.color);
  });

  it("gives each octopus parent its own lane", () => {
    const rows = buildHistoryGraph([commit("o", "a", "b", "c"), commit("a"), commit("b"), commit("c")]);

    expect(ends(rowOf(rows, "o").lower)).toEqual([[0, 0], [0, 1], [0, 2]]);
    expect(["a", "b", "c"].map((oid) => rowOf(rows, oid).lane)).toEqual([0, 0, 0]);
    expect(ends(rowOf(rows, "a").upper)).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(ends(rowOf(rows, "a").lower)).toEqual([[1, 0], [2, 1]]);
  });

  it("reuses an existing lane when a merge parent is already expected", () => {
    const rows = buildHistoryGraph([commit("t", "a"), commit("m", "x", "a"), commit("x", "a"), commit("a")]);

    expect(ends(rowOf(rows, "m").lower)).toEqual([[0, 0], [1, 1], [1, 0]]);
    expect(rowOf(rows, "a")).toMatchObject({ lane: 0 });
    expect(ends(rowOf(rows, "a").upper)).toEqual([[0, 0]]);
  });

  it("lays out disconnected histories side by side without linking them", () => {
    const rows = buildHistoryGraph([commit("a2", "a1"), commit("b2", "b1"), commit("a1"), commit("b1")]);

    expect(rowOf(rows, "b2").lane).toBe(1);
    expect(ends(rowOf(rows, "a1").lower)).toEqual([[1, 0]]);
    expect(rowOf(rows, "b1")).toMatchObject({ lane: 0, lower: [] });
  });

  it("ends lanes for parents outside the loaded commits", () => {
    const [row] = buildHistoryGraph([commit("a", "missing")]);

    expect(row?.lower).toEqual([]);
  });

  it("produces identical output for repeated input", () => {
    const commits = [commit("m", "p1", "p2"), commit("p2", "b"), commit("p1", "b"), commit("b")];

    expect(JSON.stringify(buildHistoryGraph(commits))).toBe(JSON.stringify(buildHistoryGraph(commits)));
  });
});

describe("filterHistoryGraph", () => {
  const rows = buildHistoryGraph([commit("d", "c"), commit("c", "b"), commit("b", "a"), commit("a")]);

  it("marks gaps where hidden rows sit between visible ones", () => {
    const visible = filterHistoryGraph(rows, ["d", "a"]);

    expect(visible.map((entry) => [entry.row.oid, entry.hasHiddenAbove, entry.hasHiddenBelow])).toEqual([
      ["d", false, true],
      ["a", true, false],
    ]);
  });

  it("keeps original lanes and segments without inventing edges", () => {
    const visible = filterHistoryGraph(rows, ["c"]);

    expect(visible).toEqual([{ row: rowOf(rows, "c"), hasHiddenAbove: true, hasHiddenBelow: true }]);
  });

  it("marks no gaps when every row is visible", () => {
    const visible = filterHistoryGraph(rows, ["a", "b", "c", "d"]);

    expect(visible.map((entry) => entry.row.oid)).toEqual(["d", "c", "b", "a"]);
    expect(visible.some((entry) => entry.hasHiddenAbove || entry.hasHiddenBelow)).toBe(false);
  });
});
