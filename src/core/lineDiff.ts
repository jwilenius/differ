import { type ArrayChange, diffArrays } from "diff";

/**
 * Most removed plus added lines that a line diff searches for. Myers' cost
 * grows with the square of this count: 1,500 takes about 0.25 s on fully
 * divergent inputs, where an unbounded search of 10,000 lines per side took
 * over 20 s. Beyond it, as IntelliJ does for files too big to compare, the
 * lines between the common start and end become one change.
 */
const MAX_EDIT_LENGTH = 1_500;

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
  const parts = diffWithinEditLimit(base, side) ?? replaceDifferingMiddle(base, side);
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

/** jsdiff returns `undefined` once the edit length passes `maxEditLength`, which its typings leave out. */
function diffWithinEditLimit(base: readonly string[], side: readonly string[]): ArrayChange<string>[] | undefined {
  return diffArrays(base as string[], side as string[], { maxEditLength: MAX_EDIT_LENGTH }) as ArrayChange<string>[] | undefined;
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
