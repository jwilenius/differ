/** Which of the three inputs a pane or line belongs to. */
export type Side = "local" | "base" | "remote";

/** A character range inside a line that differs from the compared side. */
export interface WordSpan {
  readonly start: number;
  readonly end: number;
}
