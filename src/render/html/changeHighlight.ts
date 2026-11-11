import type { ResolutionRow } from "../../model/resolutionView";

/** IntelliJ's change colours: what applying a side would do to the working copy. */
export type ChangeType = "added" | "deleted" | "modified" | "conflict";

export interface RowHighlight {
  readonly ours: ChangeType | null;
  readonly result: ChangeType | null;
  readonly theirs: ChangeType | null;
}

const NO_HIGHLIGHT: RowHighlight = { ours: null, result: null, theirs: null };
const CONFLICT: RowHighlight = { ours: "conflict", result: "conflict", theirs: "conflict" };

/**
 * Colours each row the way IntelliJ's merge view does. A side is highlighted
 * where it still differs from the working copy, and the whole block takes one
 * change type, so a block is not striped row by row.
 */
export function highlightRows(rows: readonly ResolutionRow[]): RowHighlight[] {
  const highlights: RowHighlight[] = [];

  for (let start = 0; start < rows.length;) {
    const end = blockEnd(rows, start);
    const block = rows.slice(start, end);
    const highlight = highlightBlock(block);

    highlights.push(...block.map(() => highlight));
    start = end;
  }

  return highlights;
}

/** One past the last row of the run of rows sharing `rows[start]`'s kind. */
function blockEnd(rows: readonly ResolutionRow[], start: number): number {
  let end = start + 1;
  while (end < rows.length && rows[end].kind === rows[start].kind) {
    end++;
  }
  return end;
}

function highlightBlock(block: readonly ResolutionRow[]): RowHighlight {
  switch (block[0].kind) {
    case "settled":
      return NO_HIGHLIGHT;
    case "unresolved":
      return CONFLICT;
    case "tookOurs": {
      const theirs = sideChange(block, "theirs");
      return { ours: null, result: theirs, theirs };
    }
    case "tookTheirs": {
      const ours = sideChange(block, "ours");
      return { ours, result: ours, theirs: null };
    }
    case "custom": {
      const ours = sideChange(block, "ours");
      const theirs = sideChange(block, "theirs");
      return { ours, result: ours === theirs ? ours : "modified", theirs };
    }
  }
}

/** Lines only the side has would be added; lines only the working copy has would be deleted. */
function sideChange(block: readonly ResolutionRow[], side: "ours" | "theirs"): ChangeType {
  const hasSideLines = block.some((row) => row[side].text !== null);
  const hasResultLines = block.some((row) => row.result.text !== null);

  if (!hasSideLines) {
    return "deleted";
  }
  return hasResultLines ? "modified" : "added";
}
