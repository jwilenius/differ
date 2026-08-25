import { diffArrays } from "diff";

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
  const parts = diffArrays(base as string[], side as string[]);
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
