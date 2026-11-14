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

/** A character range inside a line that differs from the compared side. */
export interface WordSpan {
  readonly start: number;
  readonly end: number;
}
