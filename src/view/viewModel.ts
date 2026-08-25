import { parseConflicts } from "../core/conflictParser";
import { alignThreeWay } from "../core/threeWayAligner";
import type { AlignedRow, ConflictSection, RowCell } from "../core/types";

export interface ConflictSummary {
  /** Position of this conflict among the document's conflicts, used to resolve it. */
  readonly index: number;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly localLabel: string;
  readonly remoteLabel: string;
  readonly hasBase: boolean;
}

export interface MergeViewModel {
  readonly rows: readonly AlignedRow[];
  readonly conflicts: readonly ConflictSummary[];
}

export interface ViewOptions {
  readonly wordLevelHighlighting: boolean;
}

/** Line counters, one per pane, advanced as sections are consumed. */
interface LineCursor {
  local: number;
  base: number;
  remote: number;
}

/**
 * Turns a conflicted document into one aligned row grid covering the whole file:
 * untouched text renders as context, each conflict as an aligned block.
 */
export function buildMergeView(text: string, options: ViewOptions): MergeViewModel {
  const rows: AlignedRow[] = [];
  const conflicts: ConflictSummary[] = [];
  const cursor: LineCursor = { local: 0, base: 0, remote: 0 };

  for (const section of parseConflicts(text)) {
    if (section.kind === "stable") {
      appendStableRows(rows, section.lines, cursor);
      continue;
    }

    const rowStart = rows.length;
    appendConflictRows(rows, section, cursor, options);

    conflicts.push({
      index: conflicts.length,
      rowStart,
      rowEnd: rows.length,
      localLabel: section.localLabel,
      remoteLabel: section.remoteLabel,
      hasBase: section.hasBase,
    });
  }

  return { rows, conflicts };
}

function appendStableRows(rows: AlignedRow[], lines: readonly string[], cursor: LineCursor): void {
  for (const text of lines) {
    rows.push({
      local: { text, lineNumber: cursor.local, spans: [] },
      base: { text, lineNumber: cursor.base, spans: [] },
      remote: { text, lineNumber: cursor.remote, spans: [] },
      kind: "unchanged",
      blockIndex: null,
    });
    cursor.local++;
    cursor.base++;
    cursor.remote++;
  }
}

function appendConflictRows(
  rows: AlignedRow[],
  conflict: ConflictSection,
  cursor: LineCursor,
  options: ViewOptions,
): void {
  const view = alignThreeWay(conflict.local, conflict.base, conflict.remote, options);

  for (const row of view.rows) {
    rows.push({
      ...row,
      local: shiftCell(row.local, cursor.local),
      base: shiftCell(row.base, cursor.base),
      remote: shiftCell(row.remote, cursor.remote),
    });
  }

  cursor.local += conflict.local.length;
  cursor.base += conflict.base.length;
  cursor.remote += conflict.remote.length;
}

/** Rebases a cell's line number from section-local to document-wide numbering. */
function shiftCell(cell: RowCell, offset: number): RowCell {
  if (cell.lineNumber === null) {
    return cell;
  }
  return { ...cell, lineNumber: cell.lineNumber + offset };
}
