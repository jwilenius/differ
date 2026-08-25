import { diffArrays } from "diff";
import type { ConflictSection } from "../core/types";

export type HunkSide = "ours" | "theirs";

/**
 * One independently decidable piece of a conflict. A common hunk is content both
 * sides agree on and is always included; a divided hunk is content the sides
 * disagree about, and each side can be included or left out on its own.
 */
export interface ConflictHunk {
  readonly index: number;
  readonly isCommon: boolean;
  /** Agreed content of a common hunk. Empty for a divided hunk. */
  readonly common: readonly string[];
  /** This hunk's slice of the branch's lines, agreed or not. */
  readonly ours: readonly string[];
  /** This hunk's slice of the incoming lines, agreed or not. */
  readonly theirs: readonly string[];
}

/** Where one side's slice of a hunk sits in the conflicted working copy. */
export interface HunkAnchor {
  readonly hunkIndex: number;
  readonly side: HunkSide;
  readonly startLine: number;
  readonly lineCount: number;
}

/**
 * Splits one conflict into the smallest pieces that can be decided separately,
 * so a resolution can take part of each side instead of a whole side.
 *
 * The two sides are compared directly rather than through the merge base: what
 * matters here is where they disagree, and content both sides arrived at
 * independently is already settled.
 */
export function splitConflict(section: ConflictSection): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  let pending: DividedHunk | null = null;

  const flush = (): void => {
    if (pending) {
      hunks.push({ index: hunks.length, isCommon: false, common: [], ...pending });
      pending = null;
    }
  };

  for (const part of diffArrays([...section.local], [...section.remote])) {
    if (!part.added && !part.removed) {
      flush();
      hunks.push({
        index: hunks.length,
        isCommon: true,
        common: part.value,
        ours: part.value,
        theirs: part.value,
      });
      continue;
    }

    // A removal and the addition next to it are the two sides of one disagreement.
    const side: HunkSide = part.removed ? "ours" : "theirs";
    if (pending !== null && pending[side].length > 0) {
      flush();
    }

    const open: DividedHunk = pending ?? { ours: [], theirs: [] };
    pending = side === "ours"
      ? { ours: part.value, theirs: open.theirs }
      : { ours: open.ours, theirs: part.value };
  }
  flush();

  return hunks;
}

/** Assembles the lines a set of per-side choices produces for one conflict. */
export function assembleHunks(
  hunks: readonly ConflictHunk[],
  isIncluded: (hunkIndex: number, side: HunkSide) => boolean,
): string[] {
  const lines: string[] = [];

  for (const hunk of hunks) {
    if (hunk.isCommon) {
      lines.push(...hunk.common);
      continue;
    }
    if (isIncluded(hunk.index, "ours")) {
      lines.push(...hunk.ours);
    }
    if (isIncluded(hunk.index, "theirs")) {
      lines.push(...hunk.theirs);
    }
  }

  return lines;
}

/**
 * Locates each hunk's slices in the conflicted file, so a UI can put a control
 * beside the lines it governs. Sides that contribute no lines get no anchor:
 * there is nothing to point at, and leaving them out is the same as excluding.
 */
export function hunkAnchors(
  section: ConflictSection,
  hunks: readonly ConflictHunk[],
): HunkAnchor[] {
  const anchors: HunkAnchor[] = [];
  let oursLine = section.markerStartLine + 1;
  let theirsLine = remoteStartLine(section);

  for (const hunk of hunks) {
    if (!hunk.isCommon) {
      addAnchor(anchors, hunk.index, "ours", oursLine, hunk.ours.length);
      addAnchor(anchors, hunk.index, "theirs", theirsLine, hunk.theirs.length);
    }
    oursLine += hunk.ours.length;
    theirsLine += hunk.theirs.length;
  }

  return anchors;
}

/** The first incoming line, skipping the branch block and any diff3 base block. */
function remoteStartLine(section: ConflictSection): number {
  const localBlockEnd = section.markerStartLine + 1 + section.local.length;
  const separator = section.hasBase
    ? localBlockEnd + 1 + section.base.length // `|||||||` then the base block
    : localBlockEnd;
  return separator + 1; // the `=======` line itself
}

function addAnchor(
  anchors: HunkAnchor[],
  hunkIndex: number,
  side: HunkSide,
  startLine: number,
  lineCount: number,
): void {
  if (lineCount > 0) {
    anchors.push({ hunkIndex, side, startLine, lineCount });
  }
}

interface DividedHunk {
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
}
