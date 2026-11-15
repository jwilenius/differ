import { type Change, diffWordsWithSpace } from "diff";
import type { WordSpan } from "./types";

export interface WordDiffResult {
  readonly leftSpans: readonly WordSpan[];
  readonly rightSpans: readonly WordSpan[];
}

const EMPTY: WordDiffResult = { leftSpans: [], rightSpans: [] };

/**
 * Most removed plus added words and whitespace runs that a word diff searches
 * for. Myers' cost grows with this count times the token count: 1,000 takes
 * about 0.1 s on a fully divergent block of one-letter words just under the
 * caller's 20,000-character cap, where an unbounded search took over 10 s.
 * Beyond it the block keeps only its line tint, as for blocks over the cap.
 */
const MAX_EDIT_LENGTH = 1_000;

/**
 * Edit work, in squared edit lengths, that one pass over a diff or merge may
 * spend on word diffs. Myers explores about the square of the edit length it
 * reaches, so each block under {@link MAX_EDIT_LENGTH} stays cheap, yet thirty
 * divergent blocks took 3.5 s together. This allows about two blocks at that
 * limit, 0.2 to 0.3 s, while thousands of small changed lines stay far below it.
 */
const PASS_EDIT_WORK = 2_000_000;

/**
 * The word diff work left in one pass over a diff or merge, shared by all its
 * blocks in order. Once it runs out, the remaining blocks keep only their line tint.
 */
export class WordDiffBudget {
  private remainingWork = PASS_EDIT_WORK;

  /** The longest edit a word diff may still search for without overrunning the pass. */
  affordableEditLength(): number {
    return Math.min(MAX_EDIT_LENGTH, Math.floor(Math.sqrt(this.remainingWork)));
  }

  /** Records a search that went as far as `editLength`. */
  spend(editLength: number): void {
    this.remainingWork -= editLength * editLength;
  }
}

/**
 * Finds the differing character ranges between two versions of a line, so that
 * only the words that actually changed get highlighted. Reports no ranges when
 * the versions differ in too many words to compare within what is left of `budget`.
 */
export function diffWords(left: string, right: string, budget: WordDiffBudget): WordDiffResult {
  const maxEditLength = budget.affordableEditLength();
  // jsdiff reads a `maxEditLength` of 0 as no limit.
  if (left === right || maxEditLength === 0) {
    return EMPTY;
  }

  const parts = diffWithinEditLimit(left, right, maxEditLength);
  budget.spend(parts === undefined ? maxEditLength : editLength(parts));
  if (parts === undefined) {
    return EMPTY;
  }
  const leftSpans: WordSpan[] = [];
  const rightSpans: WordSpan[] = [];

  let leftOffset = 0;
  let rightOffset = 0;

  for (const part of parts) {
    const length = part.value.length;

    if (!part.added && !part.removed) {
      leftOffset += length;
      rightOffset += length;
      continue;
    }

    if (part.removed) {
      appendSpan(leftSpans, leftOffset, leftOffset + length);
      leftOffset += length;
    } else {
      appendSpan(rightSpans, rightOffset, rightOffset + length);
      rightOffset += length;
    }
  }

  return { leftSpans, rightSpans };
}

/** jsdiff returns `undefined` once the edit length passes `maxEditLength`, which its typings leave out. */
function diffWithinEditLimit(left: string, right: string, maxEditLength: number): Change[] | undefined {
  return diffWordsWithSpace(left, right, { maxEditLength }) as Change[] | undefined;
}

/** Removed plus added words and whitespace runs, the edit length Myers reached. */
function editLength(parts: readonly Change[]): number {
  return parts.filter((part) => part.added || part.removed).reduce((length, part) => length + (part.count ?? 0), 0);
}

/** Appends a span, merging it into the previous one when they touch. */
function appendSpan(spans: WordSpan[], start: number, end: number): void {
  const previous = spans[spans.length - 1];
  if (previous && previous.end === start) {
    spans[spans.length - 1] = { start: previous.start, end };
    return;
  }
  spans.push({ start, end });
}
