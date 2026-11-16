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
  /**
   * Short lower stubs from the node for parents beyond the loaded commits:
   * straight down when no loaded parent continues the lane, else angled to
   * the lanes right of the node, one per unloaded parent.
   */
  readonly cuts: readonly GraphSegment[];
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


/** Lane state between two rows: the lanes leaving the row above and the next unused color. */
interface LaneState {
  readonly lanes: readonly Lane[];
  readonly nextColor: number;
}

/** Where a commit's node goes and the lanes at its height, before any segment is built. */
interface NodePlacement {
  readonly nodeLane: number;
  readonly nodeColor: number;
  /** Lanes at node height; those from `throughCount` on start at the node, for extra parents. */
  readonly middle: readonly (Lane | null)[];
  readonly throughCount: number;
  readonly after: LaneState;
}

interface PlacedCommit {
  readonly commit: HistoryCommit;
  /** Parents within the loaded commits. */
  readonly parents: readonly string[];
  readonly placement: NodePlacement;
}

const START: LaneState = { lanes: [], nextColor: 0 };
/** Rows between kept lane states; a request for an earlier row walks at most this far from the nearest one. */
const CHECKPOINT_INTERVAL = 64;

/**
 * Lays out the branch graph for commits ordered children before parents, on
 * demand. A row depends on the lanes left by every row above it, so a request
 * walks down to its last row without building the rows it passes. Only the
 * rows of the latest request and the lanes above every 64th row reached are
 * kept, which bounds memory for long histories and lets later requests start
 * near the rows they need.
 *
 * Parents outside `commits` get no lane, so a truncated history does not leave
 * lanes open forever; they end in `cuts` stubs instead, unlike true roots.
 */
export class HistoryGraphLayout {
  private readonly indexByOid: ReadonlyMap<string, number>;
  /** The next row to place and the lanes above it. */
  private cursor = { index: 0, state: START };
  /** Lane state above row `k * CHECKPOINT_INTERVAL`, for every such row reached so far. */
  private readonly checkpoints: LaneState[] = [START];
  private kept: ReadonlyMap<number, HistoryGraphRow> = new Map();
  private placedRowCount = 0;

  constructor(private readonly commits: readonly HistoryCommit[]) {
    this.indexByOid = new Map(commits.map((commit, index) => [commit.oid, index]));
  }

  get rowCount(): number {
    return this.commits.length;
  }

  /** Rows placed since construction, counting rows placed again; shows how far requests walked. */
  get laidOutRowCount(): number {
    return this.placedRowCount;
  }

  indexOf(oid: string): number | undefined {
    return this.indexByOid.get(oid);
  }

  /** Rows at `indices`, cheapest when they ascend. */
  rowsAt(indices: readonly number[]): readonly HistoryGraphRow[] {
    const kept = new Map<number, HistoryGraphRow>();
    const rows = indices.map((index) => {
      const row = kept.get(index) ?? this.kept.get(index) ?? this.layOut(index);
      kept.set(index, row);
      return row;
    });
    this.kept = kept;
    return rows;
  }

  private layOut(index: number): HistoryGraphRow {
    if (!Number.isInteger(index) || index < 0 || index >= this.commits.length) {
      throw new RangeError(`No graph row ${index}`);
    }
    const checkpoint = Math.min(Math.floor(index / CHECKPOINT_INTERVAL), this.checkpoints.length - 1);
    const checkpointIndex = checkpoint * CHECKPOINT_INTERVAL;
    if (this.cursor.index > index || this.cursor.index < checkpointIndex) {
      this.cursor = { index: checkpointIndex, state: this.checkpoints[checkpoint]! };
    }
    while (this.cursor.index < index) {
      this.placeNext();
    }
    const incoming = this.cursor.state.lanes;
    return buildRow(this.placeNext(), incoming);
  }

  /** Places the node of the row at the cursor and moves the cursor below it. */
  private placeNext(): PlacedCommit {
    const commit = this.commits[this.cursor.index]!;
    const parents = commit.parents.filter((parent) => this.indexByOid.has(parent));
    const placement = placeNode(commit.oid, parents, this.cursor.state);
    this.cursor = { index: this.cursor.index + 1, state: placement.after };
    this.placedRowCount++;
    // Walks start at a checkpoint or the cursor, so checkpoints are reached in order.
    if (this.cursor.index === this.checkpoints.length * CHECKPOINT_INTERVAL) {
      this.checkpoints.push(placement.after);
    }
    return { commit, parents, placement };
  }
}

/**
 * The first `limit` rows of `visibleOids` (given in graph order) with their
 * original lanes. Lines are never joined across hidden rows; the flags tell the
 * renderer to draw a continuation marker instead. Unknown OIDs are skipped.
 */
export function visibleGraphRows(layout: HistoryGraphLayout, visibleOids: readonly string[], limit: number): readonly VisibleGraphRow[] {
  // One index past the limit decides whether hidden rows follow the last shown row.
  const indices: number[] = [];
  for (const oid of visibleOids) {
    if (indices.length > limit) {
      break;
    }
    const index = layout.indexOf(oid);
    if (index !== undefined) {
      indices.push(index);
    }
  }
  const shown = indices.slice(0, limit);

  return layout.rowsAt(shown).map((row, position) => {
    const rowIndex = shown[position]!;
    const previousIndex = position === 0 ? -1 : shown[position - 1]!;
    const nextIndex = indices[position + 1] ?? layout.rowCount;
    return { row, hasHiddenAbove: rowIndex - previousIndex > 1, hasHiddenBelow: nextIndex - rowIndex > 1 };
  });
}

function placeNode(oid: string, parents: readonly string[], before: LaneState): NodePlacement {
  const incoming = before.lanes;
  const firstParent = parents[0];
  let nextColor = before.nextColor;

  // Lanes at node height: this commit's lane now waits for its first parent. Plain loops, as every walked row
  // passes over all open lanes.
  const middle: (Lane | null)[] = new Array<Lane | null>(incoming.length);
  let existingLane = -1;
  for (let index = 0; index < incoming.length; index++) {
    const lane = incoming[index]!;
    const isNode = lane.oid === oid;
    existingLane = isNode ? index : existingLane;
    middle[index] = isNode ? null : lane;
  }
  const isNewLane = existingLane < 0;
  const nodeLane = isNewLane ? incoming.length : existingLane;
  const nodeColor = isNewLane ? nextColor++ : incoming[existingLane]!.color;
  middle[nodeLane] = firstParent === undefined ? null : { oid: firstParent, color: nodeColor };
  // Lanes added after this point exist only for the extra parents and start at the node.
  const throughCount = middle.length;
  for (const parent of parents.slice(1)) {
    const isTracked = middle.some((lane) => lane?.oid === parent);
    if (!isTracked) {
      middle.push({ oid: parent, color: nextColor++ });
    }
  }

  // Ended lanes go. Incoming lanes are distinct, so only the first parent can be waited for twice; the leftmost
  // of those lanes continues.
  const outgoing: Lane[] = [];
  let isFirstParentKept = false;
  for (const lane of middle) {
    const isFirstParent = lane?.oid === firstParent;
    if (lane && !(isFirstParent && isFirstParentKept)) {
      outgoing.push(lane);
      isFirstParentKept ||= isFirstParent;
    }
  }
  return { nodeLane, nodeColor, middle, throughCount, after: { lanes: outgoing, nextColor } };
}

function buildRow({ commit, parents, placement }: PlacedCommit, incoming: readonly Lane[]): HistoryGraphRow {
  const { oid } = commit;
  const { nodeLane, nodeColor, middle, throughCount } = placement;
  const outgoing = placement.after.lanes;

  const upper: GraphSegment[] = incoming.map((lane, index) => ({
    from: index,
    to: lane.oid === oid ? nodeLane : index,
    color: lane.color,
  }));

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

  const unloadedParentCount = commit.parents.length - parents.length;
  const firstCutLane = parents.length > 0 ? nodeLane + 1 : nodeLane;
  const cuts: GraphSegment[] = Array.from({ length: unloadedParentCount }, (_unused, index) => ({
    from: nodeLane,
    to: firstCutLane + index,
    color: nodeColor,
  }));

  const widestCut = firstCutLane + unloadedParentCount;
  const width = Math.max(nodeLane + 1, incoming.length, middle.length, outgoing.length, widestCut);
  return { oid, lane: nodeLane, color: nodeColor, upper, lower, cuts, width };
}
