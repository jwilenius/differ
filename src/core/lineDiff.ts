import { type ArrayChange, diffArrays } from "diff";

/**
 * Most removed plus added lines, among those both sides contain, that a line
 * diff searches for. Myers' cost grows with the square of this count: 2,000
 * takes about 0.45 s on a reordered file, where an unbounded search of 10,000
 * lines per side took over 20 s. Beyond it, as IntelliJ does for files too big
 * to compare, the lines between the common start and end become one change.
 */
const MAX_EDIT_LENGTH = 2_000;

/** A range of `base` replaced by a range of one side. Both ends are exclusive. */
export interface Hunk {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly sideStart: number;
  readonly sideEnd: number;
}

export interface LineDiffResult {
  readonly hunks: readonly Hunk[];
  /**
   * Side index at which base line `i` begins, before any lines inserted at `i`.
   * Defined for every `i` in `0..base.length`.
   */
  readonly startPosition: readonly number[];
  /**
   * Side index just past any lines inserted at base index `i`, which is also
   * where the content of base line `i` sits. Differs from `startPosition[i]`
   * only where the side inserted lines at that point.
   */
  readonly endPosition: readonly number[];
}

/** Diffs `base` against `side` line by line and reports the changed ranges. */
export function diffLines(base: readonly string[], side: readonly string[]): LineDiffResult {
  const parts = diffSharedLines(base, side) ?? replaceDifferingMiddle(base, side);
  const startPosition = new Array<number>(base.length + 1).fill(-1);
  const endPosition = new Array<number>(base.length + 1).fill(0);
  const hunks: Hunk[] = [];

  let baseIndex = 0;
  let sideIndex = 0;
  let pending: { baseStart: number; sideStart: number } | null = null;

  const setStart = (index: number, value: number): void => {
    if (startPosition[index] === -1) {
      startPosition[index] = value;
    }
  };

  const closePending = (): void => {
    if (!pending) {
      return;
    }
    hunks.push({
      baseStart: pending.baseStart,
      baseEnd: baseIndex,
      sideStart: pending.sideStart,
      sideEnd: sideIndex,
    });
    pending = null;
  };

  setStart(0, 0);

  for (const part of parts) {
    const count = part.value.length;

    if (!part.added && !part.removed) {
      closePending();
      for (let offset = 0; offset < count; offset++) {
        setStart(baseIndex + offset, sideIndex + offset);
        endPosition[baseIndex + offset] = sideIndex + offset;
      }
      baseIndex += count;
      sideIndex += count;
      setStart(baseIndex, sideIndex);
      endPosition[baseIndex] = sideIndex;
      continue;
    }

    pending ??= { baseStart: baseIndex, sideStart: sideIndex };

    if (part.removed) {
      for (let offset = 0; offset < count; offset++) {
        setStart(baseIndex + offset, sideIndex);
        endPosition[baseIndex + offset] = sideIndex;
      }
      baseIndex += count;
      setStart(baseIndex, sideIndex);
      endPosition[baseIndex] = sideIndex;
      continue;
    }

    sideIndex += count;
    endPosition[baseIndex] = sideIndex;
  }

  closePending();

  return { hunks, startPosition, endPosition };
}

/**
 * Searches only the lines that both sides contain, then puts the others back as
 * removed or added. Like git's xdiff, but without also dropping lines that
 * match many times. A line missing from the other side can never be matched,
 * so leaving it out keeps the diff minimal, while rewritten or renamed lines
 * no longer count towards {@link MAX_EDIT_LENGTH}.
 * Undefined when the shared lines alone differ by more than it.
 */
function diffSharedLines(base: readonly string[], side: readonly string[]): ArrayChange<string>[] | undefined {
  const baseShared = indicesOfLinesIn(base, new Set(side));
  const sideShared = indicesOfLinesIn(side, new Set(base));
  const sharedParts = diffWithinEditLimit(
    baseShared.map((index) => base[index]),
    sideShared.map((index) => side[index]),
  );
  if (sharedParts === undefined) {
    return undefined;
  }

  const parts: ArrayChange<string>[] = [];
  let baseIndex = 0;
  let sideIndex = 0;
  /** Reports the lines from the last match up to these ends as removed and added. */
  const changeUpTo = (baseEnd: number, sideEnd: number): void => {
    parts.push({ value: base.slice(baseIndex, baseEnd), removed: true }, { value: side.slice(sideIndex, sideEnd), added: true });
  };

  let baseSharedIndex = 0;
  let sideSharedIndex = 0;
  for (const part of sharedParts) {
    const count = part.value.length;
    if (!part.added && !part.removed) {
      for (let offset = 0; offset < count; offset++) {
        const baseMatch = baseShared[baseSharedIndex + offset];
        const sideMatch = sideShared[sideSharedIndex + offset];
        changeUpTo(baseMatch, sideMatch);
        parts.push({ value: [base[baseMatch]] });
        baseIndex = baseMatch + 1;
        sideIndex = sideMatch + 1;
      }
    }
    if (!part.added) {
      baseSharedIndex += count;
    }
    if (!part.removed) {
      sideSharedIndex += count;
    }
  }
  changeUpTo(base.length, side.length);

  return parts.filter((part) => part.value.length > 0);
}

/** Indices of the `lines` that `otherLines` contains, in order. */
function indicesOfLinesIn(lines: readonly string[], otherLines: ReadonlySet<string>): number[] {
  const indices: number[] = [];
  lines.forEach((line, index) => {
    if (otherLines.has(line)) {
      indices.push(index);
    }
  });
  return indices;
}

/** jsdiff returns `undefined` once the edit length passes `maxEditLength`, which its typings leave out. */
function diffWithinEditLimit(base: string[], side: string[]): ArrayChange<string>[] | undefined {
  return diffArrays(base, side, { maxEditLength: MAX_EDIT_LENGTH }) as ArrayChange<string>[] | undefined;
}

/** The parts of one change that replaces every line between the common start and end. */
function replaceDifferingMiddle(base: readonly string[], side: readonly string[]): ArrayChange<string>[] {
  const shorterLength = Math.min(base.length, side.length);
  let prefixLength = 0;
  while (prefixLength < shorterLength && base[prefixLength] === side[prefixLength]) {
    prefixLength++;
  }
  let suffixLength = 0;
  while (
    suffixLength < shorterLength - prefixLength &&
    base[base.length - 1 - suffixLength] === side[side.length - 1 - suffixLength]
  ) {
    suffixLength++;
  }

  const parts: ArrayChange<string>[] = [
    { value: base.slice(0, prefixLength) },
    { value: base.slice(prefixLength, base.length - suffixLength), removed: true },
    { value: side.slice(prefixLength, side.length - suffixLength), added: true },
    { value: base.slice(base.length - suffixLength) },
  ];
  return parts.filter((part) => part.value.length > 0);
}
