import { buildMergeChunks, type MergeChunk, type MergeSide } from "./mergeChunks";
import type { LineRange } from "./twoWayDiff";

/** What the user did with one side's change in a chunk. */
export type SideResolution = "pending" | "applied" | "ignored";

/** A chunk and where it currently sits in the result. */
export interface ChunkState {
  readonly chunk: MergeChunk;
  readonly result: LineRange;
  /** Null when the side did not change this chunk, so there is nothing to decide. */
  readonly left: SideResolution | null;
  readonly right: SideResolution | null;
}

/**
 * An IntelliJ-style merge in progress: the result starts as the base version
 * and every change is applied, ignored or edited in by hand.
 */
export interface MergeState {
  readonly baseLines: readonly string[];
  readonly leftLines: readonly string[];
  readonly rightLines: readonly string[];
  readonly resultLines: readonly string[];
  readonly chunks: readonly ChunkState[];
  /** Whether anything changed the result since the merge started. */
  readonly isModified: boolean;
}

/** Which sides "Apply non-conflicting changes" takes. */
export type NonConflictingScope = MergeSide | "all";

/** Unresolved chunks, counted as IntelliJ's status line does: conflicts apart from the other changes. */
export interface MergeTally {
  readonly changes: number;
  readonly conflicts: number;
}

const LINE_SEPARATOR = "\n";

/** Starts a merge whose result is the base text; texts are split on `\n`. */
export function startMerge(baseText: string, leftText: string, rightText: string): MergeState {
  const baseLines = baseText.split(LINE_SEPARATOR);
  const leftLines = leftText.split(LINE_SEPARATOR);
  const rightLines = rightText.split(LINE_SEPARATOR);
  const chunks = buildMergeChunks(baseLines, leftLines, rightLines).map((chunk): ChunkState => ({
    chunk,
    result: chunk.base,
    left: chunk.leftKind === null ? null : "pending",
    right: chunk.rightKind === null ? null : "pending",
  }));

  return { baseLines, leftLines, rightLines, resultLines: baseLines, chunks, isModified: false };
}

export function isChunkResolved(chunkState: ChunkState): boolean {
  return chunkState.left !== "pending" && chunkState.right !== "pending";
}

export function tallyMerge(state: MergeState): MergeTally {
  const unresolved = state.chunks.filter((chunkState) => !isChunkResolved(chunkState));
  const conflicts = unresolved.filter((chunkState) => chunkState.chunk.isConflict).length;
  return { changes: unresolved.length - conflicts, conflicts };
}

/**
 * Puts one side's change into the result. In a conflict whose other side is
 * already applied it goes after that side's lines, as IntelliJ does; otherwise
 * it replaces the chunk's result lines. A no-op unless the side is pending.
 */
export function applySide(state: MergeState, index: number, side: MergeSide): MergeState {
  const chunkState = state.chunks[index];
  if (chunkState?.[side] !== "pending") {
    return state;
  }

  const { chunk, result } = chunkState;
  const sideLines = sideLinesOf(state, side).slice(chunk[side].start, chunk[side].end);
  const isAppending = chunk.isConflict && chunkState[otherSide(side)] === "applied";
  const replaced: LineRange = isAppending ? { start: result.end, end: result.end } : result;
  const edited = replaceResultLines(state, replaced, sideLines, index);
  const resolved = resolveSides(chunkState, side, "applied");

  return withChunk(edited, index, { ...resolved, result: { start: result.start, end: replaced.start + sideLines.length } });
}

/** Leaves one side's change out of the result. A no-op unless the side is pending. */
export function ignoreSide(state: MergeState, index: number, side: MergeSide): MergeState {
  const chunkState = state.chunks[index];
  if (chunkState?.[side] !== "pending") {
    return state;
  }
  return { ...withChunk(state, index, resolveSides(chunkState, side, "ignored")), isModified: true };
}

/** Applies every pending change outside a conflict, from one side or both. */
export function applyNonConflicting(state: MergeState, scope: NonConflictingScope): MergeState {
  const sides: readonly MergeSide[] = scope === "all" ? ["left", "right"] : [scope];
  let applied = state;
  state.chunks.forEach((chunkState, index) => {
    if (chunkState.chunk.isConflict) {
      return;
    }
    for (const side of sides) {
      applied = applySide(applied, index, side);
    }
  });
  return applied;
}

/** Takes one side's whole version as the result, resolving every chunk. */
export function acceptSide(state: MergeState, side: MergeSide): MergeState {
  const other = otherSide(side);
  const chunks = state.chunks.map((chunkState): ChunkState => {
    const sideResolution = chunkState[side] === null ? null : "applied";
    const otherResolution = chunkState[other] === null ? null : "ignored";
    return side === "left"
      ? { ...chunkState, result: chunkState.chunk.left, left: sideResolution, right: otherResolution }
      : { ...chunkState, result: chunkState.chunk.right, left: otherResolution, right: sideResolution };
  });

  return { ...state, resultLines: sideLinesOf(state, side), chunks, isModified: true };
}

/** Replaces the text of one result line, as typing does. */
export function editLine(state: MergeState, line: number, text: string): MergeState {
  if (!isResultLine(state, line) || state.resultLines[line] === text) {
    return state;
  }
  return replaceResultLines(state, { start: line, end: line + 1 }, [text]);
}

/** Splits a result line at `offset`, as pressing Enter does. */
export function splitLine(state: MergeState, line: number, offset: number): MergeState {
  if (!isResultLine(state, line)) {
    return state;
  }
  const text = state.resultLines[line];
  const cut = Math.max(0, Math.min(offset, text.length));
  return replaceResultLines(state, { start: line, end: line + 1 }, [text.slice(0, cut), text.slice(cut)]);
}

/** Joins a result line onto the one above, as backspacing at column zero does. */
export function joinWithPrevious(state: MergeState, line: number): MergeState {
  if (!isResultLine(state, line) || line === 0) {
    return state;
  }
  const joined = state.resultLines[line - 1] + state.resultLines[line];
  return replaceResultLines(state, { start: line - 1, end: line + 1 }, [joined]);
}

/** Replaces `count` result lines from `line` with others, as pasting over them does. */
export function replaceLines(state: MergeState, line: number, count: number, lines: readonly string[]): MergeState {
  const isWithinResult = isResultLine(state, line) && Number.isInteger(count) && count > 0 && line + count <= state.resultLines.length;
  if (!isWithinResult) {
    return state;
  }
  return replaceResultLines(state, { start: line, end: line + count }, lines);
}

function isResultLine(state: MergeState, line: number): boolean {
  return Number.isInteger(line) && line >= 0 && line < state.resultLines.length;
}

/**
 * Replaces result lines and moves the chunks to match: a chunk before the
 * edit stays, one after it shifts, and one around it resizes. The chunk at
 * `ownerIndex`, if any, is left for the caller to place, and every chunk after
 * it shifts, even an empty one at the line where the owner's lines go.
 */
function replaceResultLines(state: MergeState, range: LineRange, lines: readonly string[], ownerIndex = -1): MergeState {
  const shift = lines.length - (range.end - range.start);
  const resultLines = [...state.resultLines.slice(0, range.start), ...lines, ...state.resultLines.slice(range.end)];
  const chunks = state.chunks.map((chunkState, index): ChunkState => {
    if (index === ownerIndex) {
      return chunkState;
    }
    const followsOwner = ownerIndex !== -1 && index > ownerIndex;
    const result = followsOwner
      ? { start: chunkState.result.start + shift, end: chunkState.result.end + shift }
      : movedRange(chunkState.result, range, shift);
    return { ...chunkState, result };
  });

  return { ...state, resultLines, chunks, isModified: true };
}

/**
 * Moves a chunk past an edit without taking in lines from outside it: a
 * boundary inside the edited lines, which only a join across the chunk's edge
 * produces, moves out of them, so the joined line leaves the chunk and applying
 * a side never replaces text the user brought in from around the chunk.
 */
function movedRange(chunkRange: LineRange, edited: LineRange, shift: number): LineRange {
  const start = movedBoundary(chunkRange.start, edited, shift, edited.end + shift);
  const end = movedBoundary(chunkRange.end, edited, shift, edited.start);
  return { start, end: Math.max(start, end) };
}

/** Where a chunk boundary lands after an edit; one inside the edited lines goes to `outside`. */
function movedBoundary(line: number, edited: LineRange, shift: number, outside: number): number {
  if (line <= edited.start) {
    return line;
  }
  if (line >= edited.end) {
    return line + shift;
  }
  return outside;
}

/** Both sides made the same change in a non-conflicting chunk with two sides, so one decision settles both. */
function resolveSides(chunkState: ChunkState, side: MergeSide, resolution: SideResolution): ChunkState {
  const isSharedChange = !chunkState.chunk.isConflict && chunkState.left !== null && chunkState.right !== null;
  if (isSharedChange) {
    return { ...chunkState, left: resolution, right: resolution };
  }
  return { ...chunkState, [side]: resolution };
}

function withChunk(state: MergeState, index: number, chunkState: ChunkState): MergeState {
  return { ...state, chunks: state.chunks.map((current, position) => (position === index ? chunkState : current)) };
}

function sideLinesOf(state: MergeState, side: MergeSide): readonly string[] {
  return side === "left" ? state.leftLines : state.rightLines;
}

function otherSide(side: MergeSide): MergeSide {
  return side === "left" ? "right" : "left";
}
