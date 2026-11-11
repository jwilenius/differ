import { parseConflicts } from "../core/conflictParser";
import { alignThreeWay } from "../core/threeWayAligner";
import type { MergeSources } from "../git/gitMergeSources";
import type { BlockKind, ConflictSection, RowCell } from "../core/types";
import { HunkSelection } from "./hunkSelection";
import { assembleHunks, hunkAnchors, splitConflict, type ConflictHunk, type HunkSide } from "./hunkSplitter";

/** How a row's committed content relates to the two incoming sides. */
export type ResolutionKind =
  | "settled"
  | "tookOurs"
  | "tookTheirs"
  | "custom"
  | "unresolved";

export interface ResolutionRow {
  readonly ours: RowCell;
  readonly result: RowCell;
  readonly theirs: RowCell;
  readonly kind: ResolutionKind;
  /** True for the `<<<<<<<`, `|||||||`, `=======` and `>>>>>>>` lines themselves. */
  readonly isMarkerLine: boolean;
  /** Set on the first row of a hunk slice, where the include control belongs. */
  readonly checkbox: HunkCheckbox | null;
  /** The unresolved conflict this row lies inside, if any. */
  readonly conflictIndex: number | null;
}

/** An offer to include one side of one hunk, anchored to the row it governs. */
export interface HunkCheckbox {
  readonly conflictIndex: number;
  readonly hunkIndex: number;
  readonly side: HunkSide;
  /** How many lines this control governs, counting down from its own row. */
  readonly lineCount: number;
  readonly isIncluded: boolean;
}

export interface ConflictSummary {
  readonly index: number;
  readonly rowStart: number;
  readonly hasBase: boolean;
  /** Number of pieces the conflict divides into; more than one means it can be split. */
  readonly hunkCount: number;
  /** Lines the current selection would commit, for previewing what applying does. */
  readonly selectedLineCount: number;
}

export interface ResolutionViewModel {
  readonly rows: readonly ResolutionRow[];
  readonly conflicts: readonly ConflictSummary[];
  readonly ourLabel: string;
  readonly theirLabel: string;
  readonly isSidesSwapped: boolean;
}

export interface ViewOptions {
  readonly wordLevelHighlighting: boolean;
}

/**
 * Aligns the branch's version and the incoming version against the working copy
 * — the text that will actually be committed. The working copy is the pivot, so
 * each side shows how it still differs from what you are about to commit.
 */
export function buildResolutionView(
  sources: MergeSources,
  options: ViewOptions,
  selection: HunkSelection = new HunkSelection(),
): ResolutionViewModel {
  const resultLines = sources.result.split("\n");
  const aligned = alignThreeWay(
    sources.ours.split("\n"),
    resultLines,
    sources.theirs.split("\n"),
    options,
  );

  const regions = conflictRegions(sources.result).map((region) => withHunks(region, selection));
  const checkboxes = checkboxesByLine(regions);
  const rows: ResolutionRow[] = [];
  const conflicts: ConflictSummary[] = [];
  const seenRegions = new Set<number>();

  let lastResultLine = -1;

  for (const row of aligned.rows) {
    if (row.base.lineNumber !== null) {
      lastResultLine = row.base.lineNumber;
    }

    const region = enclosingRegion(regions, lastResultLine);
    if (region && !seenRegions.has(region.index)) {
      seenRegions.add(region.index);
      conflicts.push({
        index: region.index,
        rowStart: rows.length,
        hasBase: region.section.hasBase,
        hunkCount: region.hunks.filter((hunk) => !hunk.isCommon).length,
        selectedLineCount: region.selectedLineCount,
      });
    }

    rows.push({
      ours: row.local,
      result: row.base,
      theirs: row.remote,
      kind: region ? "unresolved" : toResolutionKind(row.kind),
      isMarkerLine: region !== null && isMarkerLine(row.base.text),
      checkbox: row.base.lineNumber === null ? null : checkboxes.get(row.base.lineNumber) ?? null,
      conflictIndex: region ? region.index : null,
    });
  }

  return {
    rows,
    conflicts,
    ourLabel: sources.ourLabel,
    theirLabel: sources.theirLabel,
    isSidesSwapped: sources.isSidesSwapped,
  };
}

interface ConflictRegion {
  readonly index: number;
  readonly section: ConflictSection;
  readonly hunks: readonly ConflictHunk[];
  readonly checkboxes: ReadonlyMap<number, HunkCheckbox>;
  readonly selectedLineCount: number;
}

function conflictRegions(result: string): { index: number; section: ConflictSection }[] {
  return parseConflicts(result)
    .filter((section): section is ConflictSection => section.kind === "conflict")
    .map((section, index) => ({ index, section }));
}

/** Splits a region into hunks and places an include control beside each side's slice. */
function withHunks(
  region: { index: number; section: ConflictSection },
  selection: HunkSelection,
): ConflictRegion {
  const hunks = splitConflict(region.section);
  const checkboxes = new Map<number, HunkCheckbox>();

  for (const anchor of hunkAnchors(region.section, hunks)) {
    checkboxes.set(anchor.startLine, {
      conflictIndex: region.index,
      hunkIndex: anchor.hunkIndex,
      side: anchor.side,
      lineCount: anchor.lineCount,
      isIncluded: selection.isIncluded(region.index, anchor.hunkIndex, anchor.side),
    });
  }

  const selectedLines = assembleHunks(hunks, (hunkIndex, side) =>
    selection.isIncluded(region.index, hunkIndex, side));

  return { ...region, hunks, checkboxes, selectedLineCount: selectedLines.length };
}

function checkboxesByLine(regions: readonly ConflictRegion[]): Map<number, HunkCheckbox> {
  const merged = new Map<number, HunkCheckbox>();
  for (const region of regions) {
    for (const [line, checkbox] of region.checkboxes) {
      merged.set(line, checkbox);
    }
  }
  return merged;
}

/** The unresolved region covering a working-copy line, if any. */
function enclosingRegion(regions: readonly ConflictRegion[], resultLine: number): ConflictRegion | null {
  if (resultLine < 0) {
    return null;
  }
  return (
    regions.find(
      ({ section }) => resultLine >= section.markerStartLine && resultLine <= section.markerEndLine,
    ) ?? null
  );
}

/**
 * Reinterprets a generic alignment result in merge terms. The aligner compares
 * each side against the pivot, which here is the working copy, so "side differs
 * from pivot" means the working copy did not take that side.
 */
function toResolutionKind(kind: BlockKind): ResolutionKind {
  switch (kind) {
    case "unchanged":
      return "settled";
    case "localChange":
      return "tookTheirs";
    case "remoteChange":
      return "tookOurs";
    case "bothSame":
    case "conflict":
      return "custom";
  }
}

function isMarkerLine(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  return /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)( |$)/.test(text);
}
