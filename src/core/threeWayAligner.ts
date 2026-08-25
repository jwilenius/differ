import { diffLines, type Hunk } from "./lineDiff";
import { diffWords } from "./wordDiff";
import type { AlignedBlock, AlignedRow, AlignedView, BlockKind, RowCell, WordSpan } from "./types";

const FILLER: RowCell = { text: null, lineNumber: null, spans: [] };

/** A stretch of base that at least one side changed, mapped onto both sides. */
interface ChangedRange {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly localStart: number;
  readonly localEnd: number;
  readonly remoteStart: number;
  readonly remoteEnd: number;
}

/**
 * Aligns three versions of a text into a single row grid, so that the same
 * logical line sits on the same visual row in all three panes. Rows where a pane
 * has nothing to show carry a filler cell.
 */
export function alignThreeWay(
  local: readonly string[],
  base: readonly string[],
  remote: readonly string[],
  options: { readonly wordLevelHighlighting: boolean } = { wordLevelHighlighting: true },
): AlignedView {
  const localDiff = diffLines(base, local);
  const remoteDiff = diffLines(base, remote);

  const changedRanges = mergeBaseRanges([...localDiff.hunks, ...remoteDiff.hunks]).map((range) => ({
    baseStart: range.start,
    baseEnd: range.end,
    localStart: localDiff.startPosition[range.start],
    localEnd: localDiff.endPosition[range.end],
    remoteStart: remoteDiff.startPosition[range.start],
    remoteEnd: remoteDiff.endPosition[range.end],
  }));

  const rows: AlignedRow[] = [];
  const blocks: AlignedBlock[] = [];
  let baseIndex = 0;

  for (const range of changedRanges) {
    appendContext(rows, base, localDiff.endPosition, remoteDiff.endPosition, baseIndex, range.baseStart);

    const rowStart = rows.length;
    const kind = classify(local, base, remote, range);
    appendChangedRows(rows, local, base, remote, range, kind, blocks.length, options.wordLevelHighlighting);

    blocks.push({ index: blocks.length, kind, rowStart, rowEnd: rows.length });
    baseIndex = range.baseEnd;
  }

  appendContext(rows, base, localDiff.endPosition, remoteDiff.endPosition, baseIndex, base.length);

  return { rows, blocks };
}

/** Emits rows for base lines that neither side touched. */
function appendContext(
  rows: AlignedRow[],
  base: readonly string[],
  localPosition: readonly number[],
  remotePosition: readonly number[],
  from: number,
  to: number,
): void {
  for (let index = from; index < to; index++) {
    const text = base[index];
    rows.push({
      local: { text, lineNumber: localPosition[index], spans: [] },
      base: { text, lineNumber: index, spans: [] },
      remote: { text, lineNumber: remotePosition[index], spans: [] },
      kind: "unchanged",
      blockIndex: null,
    });
  }
}

function appendChangedRows(
  rows: AlignedRow[],
  local: readonly string[],
  base: readonly string[],
  remote: readonly string[],
  range: ChangedRange,
  kind: BlockKind,
  blockIndex: number,
  wordLevelHighlighting: boolean,
): void {
  const localCount = range.localEnd - range.localStart;
  const baseCount = range.baseEnd - range.baseStart;
  const remoteCount = range.remoteEnd - range.remoteStart;
  const rowCount = Math.max(localCount, baseCount, remoteCount);

  for (let offset = 0; offset < rowCount; offset++) {
    const localCell = cellAt(local, range.localStart, offset, localCount);
    const baseCell = cellAt(base, range.baseStart, offset, baseCount);
    const remoteCell = cellAt(remote, range.remoteStart, offset, remoteCount);

    rows.push({
      local: wordLevelHighlighting ? withSpans(localCell, baseCell, remoteCell) : localCell,
      base: baseCell,
      remote: wordLevelHighlighting ? withSpans(remoteCell, baseCell, localCell) : remoteCell,
      kind,
      blockIndex,
    });
  }
}

function cellAt(lines: readonly string[], start: number, offset: number, count: number): RowCell {
  if (offset >= count) {
    return FILLER;
  }
  return { text: lines[start + offset], lineNumber: start + offset, spans: [] };
}

/**
 * Highlights the words in `cell` that differ from base. When base has no line to
 * compare against, the other side stands in so 2-way conflicts still highlight.
 */
function withSpans(cell: RowCell, baseCell: RowCell, otherCell: RowCell): RowCell {
  if (cell.text === null) {
    return cell;
  }

  const reference = baseCell.text ?? otherCell.text;
  if (reference === null || reference === undefined || reference === cell.text) {
    return cell;
  }

  const spans: readonly WordSpan[] = diffWords(reference, cell.text).rightSpans;
  return { ...cell, spans };
}

function classify(
  local: readonly string[],
  base: readonly string[],
  remote: readonly string[],
  range: ChangedRange,
): BlockKind {
  const localSlice = local.slice(range.localStart, range.localEnd);
  const baseSlice = base.slice(range.baseStart, range.baseEnd);
  const remoteSlice = remote.slice(range.remoteStart, range.remoteEnd);

  const isLocalChanged = !isSameLines(localSlice, baseSlice);
  const isRemoteChanged = !isSameLines(remoteSlice, baseSlice);

  if (isLocalChanged && isRemoteChanged) {
    return isSameLines(localSlice, remoteSlice) ? "bothSame" : "conflict";
  }
  if (isLocalChanged) {
    return "localChange";
  }
  if (isRemoteChanged) {
    return "remoteChange";
  }
  return "unchanged";
}

function isSameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

interface BaseRange {
  start: number;
  end: number;
}

/** Merges the base-side ranges of both sides' hunks into disjoint ranges. */
function mergeBaseRanges(hunks: readonly Hunk[]): BaseRange[] {
  const ranges = hunks
    .map((hunk) => ({ start: hunk.baseStart, end: hunk.baseEnd }))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: BaseRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    const isOverlapping = previous !== undefined && range.start <= previous.end;

    if (isOverlapping) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }

  return merged;
}
