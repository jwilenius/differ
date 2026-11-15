import { diffWords, WordDiffBudget, type WordDiffResult } from "../core/wordDiff";
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
  const budget = new WordDiffBudget();
  return state.chunks.map((chunkState, index) => describeChunk(state, chunkState, index, options, budget));
}

function describeChunk(state: MergeState, chunkState: ChunkState, index: number, options: MergeViewOptions, budget: WordDiffBudget): ChunkView {
  const { chunk } = chunkState;
  const isResolved = isChunkResolved(chunkState);
  // The side pane and the result show the two halves of one diff, so each side is diffed once.
  const sideWords: SideWords = {
    left: pendingChangeWords(state, chunkState, "left", options, budget),
    right: pendingChangeWords(state, chunkState, "right", options, budget),
  };

  return {
    index,
    tint: chunk.isConflict ? "conflict" : chunk.leftKind ?? chunk.rightKind ?? "modified",
    isResolved,
    left: describeSide(state, chunkState, "left", sideWords.left),
    right: describeSide(state, chunkState, "right", sideWords.right),
    result: chunkState.result,
    resultWords: isResolved ? [] : resultWords(state, chunkState, sideWords),
  };
}

/** Each side's changed words against base; null where they are not shown. */
type SideWords = Readonly<Record<MergeSide, WordDiffResult | null>>;

/** Words a side's pending modification changed against base; null without word level or such a modification. */
function pendingChangeWords(state: MergeState, chunkState: ChunkState, side: MergeSide, options: MergeViewOptions, budget: WordDiffBudget): WordDiffResult | null {
  const { chunk } = chunkState;
  const isWordDiffed = options.wordLevel && chunkState[side] === "pending" && chunk[`${side}Kind`] === "modified";
  if (!isWordDiffed) {
    return null;
  }
  const sideLines = side === "left" ? state.leftLines : state.rightLines;
  return changedWords(joinRange(state.baseLines, chunk.base), joinRange(sideLines, chunk[side]), budget);
}

function describeSide(state: MergeState, chunkState: ChunkState, side: MergeSide, words: WordDiffResult | null): SideChunkView {
  const range = chunkState.chunk[side];
  const resolution = chunkState[side];
  if (words === null) {
    return { range, resolution, words: [] };
  }

  const sideLines = side === "left" ? state.leftLines : state.rightLines;
  return { range, resolution, words: splitSpansByLine(words.rightSpans, sideLines, range) };
}

/**
 * IntelliJ marks in the result the base words a lone pending change replaces;
 * in a conflict, or once the result was edited, there is no single change to show.
 */
function resultWords(state: MergeState, chunkState: ChunkState, sideWords: SideWords): LineWordSpans[] {
  const { chunk, result } = chunkState;
  const side = (["left", "right"] as const).find((candidate) => chunkState[candidate] === "pending");
  const words = side === undefined ? null : sideWords[side];
  if (chunk.isConflict || words === null) {
    return [];
  }
  const baseText = joinRange(state.baseLines, chunk.base);
  const isResultBase = result.end - result.start === chunk.base.end - chunk.base.start && joinRange(state.resultLines, result) === baseText;
  if (!isResultBase) {
    return [];
  }

  return splitSpansByLine(words.leftSpans, state.resultLines, result);
}

function changedWords(baseText: string, sideText: string, budget: WordDiffBudget): ReturnType<typeof diffWords> | null {
  const isTooLarge = baseText.length + sideText.length > MAX_WORD_DIFF_CHARS;
  return isTooLarge ? null : diffWords(baseText, sideText, budget);
}
