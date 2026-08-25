import { parseConflicts } from "../core/conflictParser";
import { alignThreeWay } from "../core/threeWayAligner";
import type { MergeSources } from "../git/gitMergeSources";
import type { BlockKind, ConflictSection, RowCell } from "../core/types";

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
}

export interface ConflictSummary {
  readonly index: number;
  readonly rowStart: number;
  readonly hasBase: boolean;
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
export function buildResolutionView(sources: MergeSources, options: ViewOptions): ResolutionViewModel {
  const resultLines = sources.result.split("\n");
  const aligned = alignThreeWay(
    sources.ours.split("\n"),
    resultLines,
    sources.theirs.split("\n"),
    options,
  );

  const regions = conflictRegions(sources.result);
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
      conflicts.push({ index: region.index, rowStart: rows.length, hasBase: region.section.hasBase });
    }

    rows.push({
      ours: row.local,
      result: row.base,
      theirs: row.remote,
      kind: region ? "unresolved" : toResolutionKind(row.kind),
      isMarkerLine: region !== null && isMarkerLine(row.base.text),
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
}

function conflictRegions(result: string): ConflictRegion[] {
  return parseConflicts(result)
    .filter((section): section is ConflictSection => section.kind === "conflict")
    .map((section, index) => ({ index, section }));
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
