/** Which of the three inputs a pane or line belongs to. */
export type Side = "local" | "base" | "remote";

/** A run of text that carries a conflict, expressed in document line numbers. */
export interface ConflictSection {
  readonly kind: "conflict";
  readonly local: readonly string[];
  readonly base: readonly string[];
  readonly remote: readonly string[];
  /** 0-based document line of the `<<<<<<<` marker. */
  readonly markerStartLine: number;
  /** 0-based document line of the `>>>>>>>` marker. */
  readonly markerEndLine: number;
  readonly localLabel: string;
  readonly remoteLabel: string;
  /** False when the file used 2-way markers, so `base` had to be inferred as empty. */
  readonly hasBase: boolean;
}

/** Text outside any conflict, identical on all three sides. */
export interface StableSection {
  readonly kind: "stable";
  readonly lines: readonly string[];
  readonly startLine: number;
}

export type Section = StableSection | ConflictSection;

/** How a block of aligned rows differs across the three sides. */
export type BlockKind =
  | "unchanged"
  | "localChange"
  | "remoteChange"
  | "bothSame"
  | "conflict";

/** A character range inside a line that differs from the compared side. */
export interface WordSpan {
  readonly start: number;
  readonly end: number;
}

/** One side's slot in an aligned row; `null` text means the pane has no line here. */
export interface RowCell {
  readonly text: string | null;
  /** 0-based line number within that side's own text, or `null` for filler. */
  readonly lineNumber: number | null;
  readonly spans: readonly WordSpan[];
}

export interface AlignedRow {
  readonly local: RowCell;
  readonly base: RowCell;
  readonly remote: RowCell;
  readonly kind: BlockKind;
  /** Index of the block this row belongs to, or `null` for unchanged context. */
  readonly blockIndex: number | null;
}

/** A contiguous group of rows sharing one `BlockKind`. */
export interface AlignedBlock {
  readonly index: number;
  readonly kind: BlockKind;
  readonly rowStart: number;
  readonly rowEnd: number;
}

export interface AlignedView {
  readonly rows: readonly AlignedRow[];
  readonly blocks: readonly AlignedBlock[];
}
