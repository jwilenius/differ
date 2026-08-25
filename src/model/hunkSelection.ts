import type { HunkSide } from "./hunkSplitter";

/**
 * Which side of which hunk the user has chosen to include, per conflict. This is
 * pending intent, not file content: a conflict keeps its markers until the
 * selection is applied, which is what keeps its hunks derivable while you decide.
 */
export class HunkSelection {
  private readonly included = new Set<string>();

  isIncluded(conflictIndex: number, hunkIndex: number, side: HunkSide): boolean {
    return this.included.has(key(conflictIndex, hunkIndex, side));
  }

  toggle(conflictIndex: number, hunkIndex: number, side: HunkSide): void {
    const entry = key(conflictIndex, hunkIndex, side);
    if (!this.included.delete(entry)) {
      this.included.add(entry);
    }
  }

  /** Includes every hunk of one side, which is how "take a whole side" is expressed. */
  setSide(conflictIndex: number, hunkIndexes: readonly number[], side: HunkSide, isIncluded: boolean): void {
    for (const hunkIndex of hunkIndexes) {
      const entry = key(conflictIndex, hunkIndex, side);
      if (isIncluded) {
        this.included.add(entry);
      } else {
        this.included.delete(entry);
      }
    }
  }

  /**
   * Drops a resolved conflict and renumbers the ones after it, since collapsing a
   * region shifts every later conflict's index down by one.
   */
  forgetConflict(conflictIndex: number): void {
    const remaining = [...this.included]
      .map(parse)
      .filter((entry) => entry.conflictIndex !== conflictIndex)
      .map((entry) =>
        entry.conflictIndex < conflictIndex
          ? entry
          : { ...entry, conflictIndex: entry.conflictIndex - 1 }
      );

    this.included.clear();
    for (const entry of remaining) {
      this.included.add(key(entry.conflictIndex, entry.hunkIndex, entry.side));
    }
  }
}

interface SelectionEntry {
  readonly conflictIndex: number;
  readonly hunkIndex: number;
  readonly side: HunkSide;
}

function key(conflictIndex: number, hunkIndex: number, side: HunkSide): string {
  return `${conflictIndex}:${hunkIndex}:${side}`;
}

function parse(entry: string): SelectionEntry {
  const [conflictIndex, hunkIndex, side] = entry.split(":");
  return { conflictIndex: Number(conflictIndex), hunkIndex: Number(hunkIndex), side: side as HunkSide };
}
