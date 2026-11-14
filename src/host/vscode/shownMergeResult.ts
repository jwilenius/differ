import type { TokenStyle } from "../../model/syntaxTokens";
import type { LineMarkup } from "../../render/html/mergeViewRenderer";
import { editedLines, type LineEdit, type MergeHighlightUpdate } from "./mergeMessages";

/** A result line whose markup changed, as a highlight update sends it. */
export type ChangedResultLine = MergeHighlightUpdate["lines"][number];

/** The result as the shown page draws it, so highlighting it again after an edit sends only the lines that changed. */
export class ShownMergeResult {
  /** Each line's markup as last sent; null for a line the page changed itself. */
  private lines: (string | null)[];
  private styleTable: readonly TokenStyle[];
  private latestSeq = 0;

  constructor(markup: readonly LineMarkup[], styles: readonly TokenStyle[]) {
    this.lines = markup.map((line) => line.html);
    this.styleTable = styles;
  }

  /** The page's token style table; the indexes its lines use never change. */
  get styles(): readonly TokenStyle[] {
    return this.styleTable;
  }

  /** The `seq` of the latest edit the page numbered. */
  get seq(): number {
    return this.latestSeq;
  }

  /** The page drew the lines an edit left without highlighting them. */
  noteEdit(edit: LineEdit): void {
    const { line, removed, added } = editedLines(edit);
    this.lines.splice(line, removed, ...new Array<null>(added).fill(null));
    if (edit.type !== "editLine") {
      this.latestSeq = edit.seq;
    }
  }

  /** The lines of `markup` the page draws differently; from now on the page draws `markup` with `styles`. */
  update(markup: readonly LineMarkup[], styles: readonly TokenStyle[]): ChangedResultLine[] {
    const changed = markup.flatMap((line, index) => (line.html === this.lines[index] ? [] : [{ line: index, ...line }]));
    this.lines = markup.map((line) => line.html);
    this.styleTable = styles;
    return changed;
  }
}
