import { diffLines, type Hunk } from "../core/lineDiff";
import type { LineRange } from "./twoWayDiff";

export type MergeSide = "left" | "right";

/** How one side changed a chunk's base lines. */
export type SideChangeKind = "added" | "deleted" | "modified";

/**
 * A run of base lines that at least one side changed, as IntelliJ's merge
 * view groups them: changes from the two sides that overlap or touch belong to
 * one chunk, which is a conflict when both sides changed it differently.
 */
export interface MergeChunk {
  readonly base: LineRange;
  readonly left: LineRange;
  readonly right: LineRange;
  /** Null when the side left these base lines as they were. */
  readonly leftKind: SideChangeKind | null;
  readonly rightKind: SideChangeKind | null;
  readonly isConflict: boolean;
}

interface SideHunk {
  readonly side: MergeSide;
  readonly hunk: Hunk;
}

interface HunkGroup {
  readonly base: LineRange;
  readonly members: readonly SideHunk[];
}

/** Finds the chunks that the left and right versions changed relative to base, in base order. */
export function buildMergeChunks(base: readonly string[], left: readonly string[], right: readonly string[]): MergeChunk[] {
  const leftHunks = diffLines(base, left).hunks;
  const rightHunks = diffLines(base, right).hunks;
  const sides: Readonly<Record<MergeSide, readonly string[]>> = { left, right };

  return groupHunks(leftHunks, rightHunks).map((group) => {
    const leftRange = sideRange(group, "left", leftHunks);
    const rightRange = sideRange(group, "right", rightHunks);
    const leftKind = changeKind(group, "left", leftRange);
    const rightKind = changeKind(group, "right", rightRange);
    const isSameChange = sameLines(sides.left, leftRange, sides.right, rightRange);
    const isConflict = leftKind !== null && rightKind !== null && !isSameChange;

    return { base: group.base, left: leftRange, right: rightRange, leftKind, rightKind, isConflict };
  });
}

/**
 * Sweeps both sides' hunks in base order; a hunk joins the open group when it
 * starts at or before the group's end, so touching changes conflict as in git.
 */
function groupHunks(leftHunks: readonly Hunk[], rightHunks: readonly Hunk[]): HunkGroup[] {
  const sideHunks: SideHunk[] = [
    ...leftHunks.map((hunk): SideHunk => ({ side: "left", hunk })),
    ...rightHunks.map((hunk): SideHunk => ({ side: "right", hunk })),
  ].sort((first, second) => first.hunk.baseStart - second.hunk.baseStart || first.hunk.baseEnd - second.hunk.baseEnd);

  const groups: HunkGroup[] = [];
  for (const sideHunk of sideHunks) {
    const open = groups[groups.length - 1];
    const isJoiningOpenGroup = open !== undefined && sideHunk.hunk.baseStart <= open.base.end;
    if (!isJoiningOpenGroup) {
      groups.push({ base: { start: sideHunk.hunk.baseStart, end: sideHunk.hunk.baseEnd }, members: [sideHunk] });
      continue;
    }
    groups[groups.length - 1] = {
      base: { start: open.base.start, end: Math.max(open.base.end, sideHunk.hunk.baseEnd) },
      members: [...open.members, sideHunk],
    };
  }
  return groups;
}

/**
 * The side's lines for the group's base range: its own hunks widened by the
 * unchanged base lines around them, or the base range shifted by the line
 * count the side's earlier hunks added or removed.
 */
function sideRange(group: HunkGroup, side: MergeSide, allHunks: readonly Hunk[]): LineRange {
  const hunks = group.members.filter((member) => member.side === side).map((member) => member.hunk);
  const first = hunks[0];
  const last = hunks[hunks.length - 1];
  if (first === undefined || last === undefined) {
    const shift = lineShiftBefore(allHunks, group.base.start);
    return { start: group.base.start + shift, end: group.base.end + shift };
  }

  return {
    start: first.sideStart - (first.baseStart - group.base.start),
    end: last.sideEnd + (group.base.end - last.baseEnd),
  };
}

function lineShiftBefore(hunks: readonly Hunk[], baseLine: number): number {
  return hunks
    .filter((hunk) => hunk.baseEnd <= baseLine)
    .reduce((shift, hunk) => shift + (hunk.sideEnd - hunk.sideStart) - (hunk.baseEnd - hunk.baseStart), 0);
}

function changeKind(group: HunkGroup, side: MergeSide, range: LineRange): SideChangeKind | null {
  const hasChanges = group.members.some((member) => member.side === side);
  if (!hasChanges) {
    return null;
  }
  if (group.base.start === group.base.end) {
    return "added";
  }
  if (range.start === range.end) {
    return "deleted";
  }
  return "modified";
}

function sameLines(first: readonly string[], firstRange: LineRange, second: readonly string[], secondRange: LineRange): boolean {
  const length = firstRange.end - firstRange.start;
  if (length !== secondRange.end - secondRange.start) {
    return false;
  }
  for (let offset = 0; offset < length; offset++) {
    if (first[firstRange.start + offset] !== second[secondRange.start + offset]) {
      return false;
    }
  }
  return true;
}
