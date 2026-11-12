import type { HistoryCommit } from "./historyTypes";

/**
 * One line drawn within half a row, from lane `from` to lane `to`. Upper
 * segments run from the row's top edge to its node height; lower segments run
 * from node height to the bottom edge. `color` is a stable per-lane counter;
 * renderers reduce it to their palette size.
 */
export interface GraphSegment {
  readonly from: number;
  readonly to: number;
  readonly color: number;
}

/** Layout of one commit row in the complete loaded graph. */
export interface HistoryGraphRow {
  readonly oid: string;
  readonly lane: number;
  readonly color: number;
  readonly upper: readonly GraphSegment[];
  readonly lower: readonly GraphSegment[];
  /** Number of lane positions this row touches; at least `lane + 1`. */
  readonly width: number;
}

/** A row kept by a filter, with markers where filtered-out rows interrupt its lines. */
export interface VisibleGraphRow {
  readonly row: HistoryGraphRow;
  readonly hasHiddenAbove: boolean;
  readonly hasHiddenBelow: boolean;
}

/** A lane waiting for the commit `oid` to appear further down. */
interface Lane {
  readonly oid: string;
  readonly color: number;
}

interface RowLayoutResult {
  readonly row: HistoryGraphRow;
  readonly lanes: readonly Lane[];
  readonly nextColor: number;
}

/**
 * Lays out the branch graph for commits ordered children before parents.
 * Parents outside `commits` are not drawn, so a truncated history ends its
 * lanes like roots instead of leaving lanes open forever.
 */
export function buildHistoryGraph(commits: readonly HistoryCommit[]): readonly HistoryGraphRow[] {
  const loadedOids = new Set(commits.map((commit) => commit.oid));
  const rows: HistoryGraphRow[] = [];
  let lanes: readonly Lane[] = [];
  let nextColor = 0;

  for (const commit of commits) {
    const parents = commit.parents.filter((parent) => loadedOids.has(parent));
    const layout = layoutRow(commit.oid, parents, lanes, nextColor);
    rows.push(layout.row);
    lanes = layout.lanes;
    nextColor = layout.nextColor;
  }
  return rows;
}

/**
 * Keeps rows whose OID is visible, in graph order, with their original lanes.
 * Lines are never joined across hidden rows; the flags tell the renderer to
 * draw a continuation marker instead.
 */
export function filterHistoryGraph(rows: readonly HistoryGraphRow[], visibleOids: readonly string[]): readonly VisibleGraphRow[] {
  const visible = new Set(visibleOids);
  const keptIndices = rows.flatMap((row, index) => (visible.has(row.oid) ? [index] : []));

  return keptIndices.map((rowIndex, position) => {
    const previousIndex = position === 0 ? -1 : keptIndices[position - 1]!;
    const nextIndex = position === keptIndices.length - 1 ? rows.length : keptIndices[position + 1]!;
    return {
      row: rows[rowIndex]!,
      hasHiddenAbove: rowIndex - previousIndex > 1,
      hasHiddenBelow: nextIndex - rowIndex > 1,
    };
  });
}

function layoutRow(oid: string, parents: readonly string[], incoming: readonly Lane[], firstFreeColor: number): RowLayoutResult {
  let nextColor = firstFreeColor;
  const existingLane = incoming.findIndex((lane) => lane.oid === oid);
  const isNewLane = existingLane < 0;
  const nodeLane = isNewLane ? incoming.length : existingLane;
  const nodeColor = isNewLane ? nextColor++ : incoming[existingLane]!.color;

  const upper: GraphSegment[] = incoming.map((lane, index) => ({
    from: index,
    to: lane.oid === oid ? nodeLane : index,
    color: lane.color,
  }));

  // Lanes at node height: this commit's lane now waits for its first parent.
  const middle: (Lane | null)[] = incoming.map((lane) => (lane.oid === oid ? null : lane));
  middle[nodeLane] = parents.length > 0 ? { oid: parents[0]!, color: nodeColor } : null;
  // Lanes added after this point exist only for the extra parents and start at the node.
  const throughCount = middle.length;
  for (const parent of parents.slice(1)) {
    const isTracked = middle.some((lane) => lane?.oid === parent);
    if (!isTracked) {
      middle.push({ oid: parent, color: nextColor++ });
    }
  }

  const outgoing = collapseLanes(middle);
  const outgoingIndex = new Map(outgoing.map((lane, index) => [lane.oid, index]));
  const laneOf = (parent: string): number => outgoingIndex.get(parent)!;

  const lower: GraphSegment[] = [];
  middle.slice(0, throughCount).forEach((lane, index) => {
    if (lane !== null && index !== nodeLane) {
      lower.push({ from: index, to: laneOf(lane.oid), color: lane.color });
    }
  });
  parents.forEach((parent, parentIndex) => {
    const color = parentIndex === 0 ? nodeColor : outgoing[laneOf(parent)]!.color;
    lower.push({ from: nodeLane, to: laneOf(parent), color });
  });

  const width = Math.max(nodeLane + 1, incoming.length, middle.length, outgoing.length);
  const row: HistoryGraphRow = { oid, lane: nodeLane, color: nodeColor, upper, lower, width };
  return { row, lanes: outgoing, nextColor };
}

/** Drops ended lanes and merges lanes waiting for the same commit into the leftmost one. */
function collapseLanes(middle: readonly (Lane | null)[]): readonly Lane[] {
  const seen = new Set<string>();
  const lanes: Lane[] = [];
  for (const lane of middle) {
    if (lane === null || seen.has(lane.oid)) {
      continue;
    }
    seen.add(lane.oid);
    lanes.push(lane);
  }
  return lanes;
}
