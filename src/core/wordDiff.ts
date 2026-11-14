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
 * Finds the differing character ranges between two versions of a line, so that
 * only the words that actually changed get highlighted. Reports no ranges when
 * the versions differ in too many words to compare.
 */
export function diffWords(left: string, right: string): WordDiffResult {
  if (left === right) {
    return EMPTY;
  }

  const parts = diffWithinEditLimit(left, right);
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
function diffWithinEditLimit(left: string, right: string): Change[] | undefined {
  return diffWordsWithSpace(left, right, { maxEditLength: MAX_EDIT_LENGTH }) as Change[] | undefined;
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
