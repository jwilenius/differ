import { parseConflicts } from "../core/conflictParser";
import { resolvedLines, type Resolution } from "../core/mergeResolver";
import { readMergeSources, type MergeSources } from "../git/gitMergeSources";
import type { ConflictSection } from "../core/types";
import type { MergeDocument } from "./mergeDocument";
import { buildResolutionView, type ResolutionViewModel, type ViewOptions } from "./resolutionView";

const MARKER_LINE = /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)( |$)/;

export type ResolveOutcome = "applied" | "gone" | "failed";

/**
 * Host-independent merge logic: reads the three versions of a file, builds the
 * view model, and applies resolutions to the working copy. A UI only has to
 * render what `load` returns and call `resolve` on user input.
 */
export class ResolutionController {
  constructor(private readonly document: MergeDocument) {}

  /** Builds the current view model, or `null` if the file is not a conflicted merge. */
  async load(options: ViewOptions): Promise<ResolutionViewModel | null> {
    const sources = await this.readSources();
    if (!sources) {
      return null;
    }
    return buildResolutionView(sources, options);
  }

  /** Collapses one conflict in the working copy to the chosen side. */
  async resolve(conflictIndex: number, resolution: Resolution): Promise<ResolveOutcome> {
    const conflict = this.conflictAt(conflictIndex);
    if (!conflict) {
      return "gone";
    }

    const isApplied = await this.document.replaceLines(
      conflict.markerStartLine,
      conflict.markerEndLine,
      resolvedLines(conflict, resolution),
    );

    return isApplied ? "applied" : "failed";
  }

  /** Replaces the text of one working-copy line, leaving line numbering intact. */
  async editLine(lineNumber: number, text: string): Promise<boolean> {
    if (!this.isEditableLine(lineNumber)) {
      return false;
    }
    return this.document.replaceLines(lineNumber, lineNumber, [text]);
  }

  /** Splits a line at `offset`, as pressing Enter does. */
  async splitLine(lineNumber: number, offset: number): Promise<boolean> {
    const line = this.lineAt(lineNumber);
    if (line === null || !this.isEditableLine(lineNumber)) {
      return false;
    }

    const cut = Math.max(0, Math.min(offset, line.length));
    return this.document.replaceLines(lineNumber, lineNumber, [line.slice(0, cut), line.slice(cut)]);
  }

  /** Joins a line onto the one above, as backspacing at column zero does. */
  async joinWithPrevious(lineNumber: number): Promise<boolean> {
    const previous = this.lineAt(lineNumber - 1);
    const line = this.lineAt(lineNumber);
    const isJoinable = previous !== null && line !== null
      && this.isEditableLine(lineNumber) && this.isEditableLine(lineNumber - 1);

    if (!isJoinable) {
      return false;
    }
    return this.document.replaceLines(lineNumber - 1, lineNumber, [previous + line]);
  }

  /**
   * Conflict markers are structural: they are resolved with the actions rather
   * than typed over, so that a half-edited marker cannot corrupt the region.
   */
  private isEditableLine(lineNumber: number): boolean {
    const line = this.lineAt(lineNumber);
    return line !== null && !MARKER_LINE.test(line);
  }

  private lineAt(lineNumber: number): string | null {
    const lines = this.document.getText().split("\n");
    if (lineNumber < 0 || lineNumber >= lines.length) {
      return null;
    }
    return lines[lineNumber];
  }

  private conflictAt(index: number): ConflictSection | null {
    const conflicts = parseConflicts(this.document.getText()).filter(
      (section): section is ConflictSection => section.kind === "conflict",
    );
    return conflicts[index] ?? null;
  }

  private async readSources(): Promise<MergeSources | null> {
    return readMergeSources(this.document.filePath, this.document.getText());
  }
}