import { diffWordsWithSpace } from "diff";
import type { WordSpan } from "./types";

export interface WordDiffResult {
  readonly leftSpans: readonly WordSpan[];
  readonly rightSpans: readonly WordSpan[];
}

const EMPTY: WordDiffResult = { leftSpans: [], rightSpans: [] };

/**
 * Finds the differing character ranges between two versions of a line, so that
 * only the words that actually changed get highlighted.
 */
export function diffWords(left: string, right: string): WordDiffResult {
  if (left === right) {
    return EMPTY;
  }

  const parts = diffWordsWithSpace(left, right);
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

/** Appends a span, merging it into the previous one when they touch. */
function appendSpan(spans: WordSpan[], start: number, end: number): void {
  const previous = spans[spans.length - 1];
  if (previous && previous.end === start) {
    spans[spans.length - 1] = { start: previous.start, end };
    return;
  }
  spans.push({ start, end });
}
