import { diffLines } from "../core/lineDiff";
import type { WordSpan } from "../core/types";
import { diffWords } from "../core/wordDiff";

export type DiffBlockKind = "added" | "deleted" | "modified";

/** Zero-based lines `[start, end)`; an empty range marks the point between two lines. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The changed character ranges of one line inside a block. */
export interface LineWordSpans {
  /** Zero-based line in the whole text, not in the block. */
  readonly line: number;
  readonly spans: readonly WordSpan[];
}

/** One difference: a run of base lines replaced by a run of result lines. */
export interface DiffBlock {
  readonly kind: DiffBlockKind;
  readonly base: LineRange;
  readonly result: LineRange;
  /** Only lines that contain changed words; empty unless the block is modified and word level is on. */
  readonly baseWords: readonly LineWordSpans[];
  readonly resultWords: readonly LineWordSpans[];
}

export interface TwoWayDiff {
  readonly blocks: readonly DiffBlock[];
  readonly baseLineCount: number;
  readonly resultLineCount: number;
}

export interface TwoWayDiffOptions {
  readonly wordLevel: boolean;
}

const LINE_SEPARATOR = "\n";
/** Word diffing is quadratic in the worst case; larger blocks keep only their line tint, as in IntelliJ. */
export const MAX_WORD_DIFF_CHARS = 20_000;

/**
 * Compares two texts line by line, as IntelliJ's side-by-side diff does.
 * Lines are split on `\n`, matching {@link HighlightedText.lines}.
 */
export function buildTwoWayDiff(baseText: string, resultText: string, options: TwoWayDiffOptions): TwoWayDiff {
  const baseLines = baseText.split(LINE_SEPARATOR);
  const resultLines = resultText.split(LINE_SEPARATOR);
  const blocks = diffLines(baseLines, resultLines).hunks.map((hunk) =>
    createBlock(
      { start: hunk.baseStart, end: hunk.baseEnd },
      { start: hunk.sideStart, end: hunk.sideEnd },
      baseLines,
      resultLines,
      options,
    )
  );

  return { blocks, baseLineCount: baseLines.length, resultLineCount: resultLines.length };
}

function createBlock(
  base: LineRange,
  result: LineRange,
  baseLines: readonly string[],
  resultLines: readonly string[],
  options: TwoWayDiffOptions,
): DiffBlock {
  const kind = blockKind(base, result);
  const baseText = joinRange(baseLines, base);
  const resultText = joinRange(resultLines, result);
  const isTooLarge = baseText.length + resultText.length > MAX_WORD_DIFF_CHARS;
  if (kind !== "modified" || !options.wordLevel || isTooLarge) {
    return { kind, base, result, baseWords: [], resultWords: [] };
  }

  const words = diffWords(baseText, resultText);
  return {
    kind,
    base,
    result,
    baseWords: splitSpansByLine(words.leftSpans, baseLines, base),
    resultWords: splitSpansByLine(words.rightSpans, resultLines, result),
  };
}

function blockKind(base: LineRange, result: LineRange): DiffBlockKind {
  if (base.start === base.end) {
    return "added";
  }
  if (result.start === result.end) {
    return "deleted";
  }
  return "modified";
}

function joinRange(lines: readonly string[], range: LineRange): string {
  return lines.slice(range.start, range.end).join(LINE_SEPARATOR);
}

/**
 * The block is word-diffed as one string so that lines can pair up even when
 * the counts differ; this maps the resulting offsets back onto its lines.
 */
function splitSpansByLine(spans: readonly WordSpan[], lines: readonly string[], range: LineRange): LineWordSpans[] {
  const result: LineWordSpans[] = [];
  let lineOffset = 0;

  for (let line = range.start; line < range.end; line++) {
    const lineEnd = lineOffset + lines[line].length;
    const lineSpans = spans
      .map((span) => ({ start: Math.max(span.start, lineOffset) - lineOffset, end: Math.min(span.end, lineEnd) - lineOffset }))
      .filter((span) => span.start < span.end);
    if (lineSpans.length > 0) {
      result.push({ line, spans: lineSpans });
    }
    lineOffset = lineEnd + LINE_SEPARATOR.length;
  }

  return result;
}
