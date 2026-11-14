import { diffWords } from "../core/wordDiff";
import type { MergeSide, SideChangeKind } from "./mergeChunks";
import { isChunkResolved, type ChunkState, type MergeState, type SideResolution } from "./mergeSession";
import { joinRange, MAX_WORD_DIFF_CHARS, splitSpansByLine, type LineRange, type LineWordSpans } from "./twoWayDiff";

/** The colour a chunk is drawn in, as in IntelliJ: conflicts apart, otherwise how the side changed it. */
export type ChunkTint = "conflict" | SideChangeKind;

/** A chunk as one side pane shows it. */
export interface SideChunkView {
  readonly range: LineRange;
  /** Null when the side did not change the chunk. */
  readonly resolution: SideResolution | null;
  /** Changed words against base; only for a pending modification with word level on. */
  readonly words: readonly LineWordSpans[];
}

export interface ChunkView {
  readonly index: number;
  readonly tint: ChunkTint;
  readonly isResolved: boolean;
  readonly left: SideChunkView;
  readonly right: SideChunkView;
  readonly result: LineRange;
  /** Base words one pending side modifies, while the result still holds those base lines. */
  readonly resultWords: readonly LineWordSpans[];
}

export interface MergeViewOptions {
  readonly wordLevel: boolean;
}

/** Describes what each pane highlights for every chunk of a merge. */
export function describeMerge(state: MergeState, options: MergeViewOptions): ChunkView[] {
  return state.chunks.map((chunkState, index) => describeChunk(state, chunkState, index, options));
}

function describeChunk(state: MergeState, chunkState: ChunkState, index: number, options: MergeViewOptions): ChunkView {
  const { chunk } = chunkState;
  const isResolved = isChunkResolved(chunkState);
  const left = describeSide(state, chunkState, "left", options);
  const right = describeSide(state, chunkState, "right", options);

  return {
    index,
    tint: chunk.isConflict ? "conflict" : chunk.leftKind ?? chunk.rightKind ?? "modified",
    isResolved,
    left,
    right,
    result: chunkState.result,
    resultWords: isResolved ? [] : resultWords(state, chunkState, options),
  };
}

function describeSide(state: MergeState, chunkState: ChunkState, side: MergeSide, options: MergeViewOptions): SideChunkView {
  const range = chunkState.chunk[side];
  const resolution = chunkState[side];
  const isWordDiffed = options.wordLevel && resolution === "pending" && chunkState.chunk[`${side}Kind`] === "modified";
  if (!isWordDiffed) {
    return { range, resolution, words: [] };
  }

  const sideLines = side === "left" ? state.leftLines : state.rightLines;
  const spans = changedWords(joinRange(state.baseLines, chunkState.chunk.base), joinRange(sideLines, range))?.rightSpans ?? [];
  return { range, resolution, words: splitSpansByLine(spans, sideLines, range) };
}

/**
 * IntelliJ marks in the result the base words a lone pending change replaces;
 * in a conflict, or once the result was edited, there is no single change to show.
 */
function resultWords(state: MergeState, chunkState: ChunkState, options: MergeViewOptions): LineWordSpans[] {
  const { chunk, result } = chunkState;
  const side = (["left", "right"] as const).find((candidate) => chunkState[candidate] === "pending");
  if (!options.wordLevel || chunk.isConflict || side === undefined || chunk[`${side}Kind`] !== "modified") {
    return [];
  }
  const baseText = joinRange(state.baseLines, chunk.base);
  const isResultBase = result.end - result.start === chunk.base.end - chunk.base.start && joinRange(state.resultLines, result) === baseText;
  if (!isResultBase) {
    return [];
  }

  const sideLines = side === "left" ? state.leftLines : state.rightLines;
  const spans = changedWords(baseText, joinRange(sideLines, chunk[side]))?.leftSpans ?? [];
  return splitSpansByLine(spans, state.resultLines, result);
}

function changedWords(baseText: string, sideText: string): ReturnType<typeof diffWords> | null {
  const isTooLarge = baseText.length + sideText.length > MAX_WORD_DIFF_CHARS;
  return isTooLarge ? null : diffWords(baseText, sideText);
}
