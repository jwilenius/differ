import { parseConflicts } from "../core/conflictParser";
import { resolvedLines, type Resolution } from "../core/mergeResolver";
import { readMergeSources, type MergeSources } from "../git/gitMergeSources";
import type { ConflictSection } from "../core/types";
import type { MergeDocument } from "./mergeDocument";
import { HunkSelection } from "./hunkSelection";
import { assembleHunks, splitConflict, type ConflictHunk, type HunkSide } from "./hunkSplitter";
import { buildResolutionView, type ResolutionViewModel, type ViewOptions } from "./resolutionView";

const MARKER_LINE = /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)( |$)/;

export type ResolveOutcome = "applied" | "gone" | "failed";

/**
 * Host-independent merge logic: reads the three versions of a file, builds the
 * view model, and applies resolutions to the working copy. A UI only has to
 * render what `load` returns and call `resolve` on user input.
 */
export class ResolutionController {
  private readonly selection = new HunkSelection();

  constructor(private readonly document: MergeDocument) {}

  /** Builds the current view model, or `null` if the file is not a conflicted merge. */
  async load(options: ViewOptions): Promise<ResolutionViewModel | null> {
    const sources = await this.readSources();
    if (!sources) {
      return null;
    }
    return buildResolutionView(sources, options, this.selection);
  }

  /** Collapses one conflict in the working copy to the chosen side. */
  async resolve(conflictIndex: number, resolution: Resolution): Promise<ResolveOutcome> {
    const conflict = this.conflictAt(conflictIndex);
    if (!conflict) {
      return "gone";
    }

    return this.replaceConflict(conflictIndex, conflict, resolvedLines(conflict, resolution));
  }

  /** The pieces one conflict divides into, each decidable on its own. */
  hunksFor(conflictIndex: number): ConflictHunk[] {
    const conflict = this.conflictAt(conflictIndex);
    return conflict ? splitConflict(conflict) : [];
  }

  /** Includes or drops one side of one hunk. Nothing is written until it is applied. */
  toggleHunk(conflictIndex: number, hunkIndex: number, side: HunkSide): void {
    this.selection.toggle(conflictIndex, hunkIndex, side);
  }

  /** Includes or drops every hunk of one side at once. */
  toggleSide(conflictIndex: number, side: HunkSide, isIncluded: boolean): void {
    const divided = this.hunksFor(conflictIndex).filter((hunk) => !hunk.isCommon);
    this.selection.setSide(conflictIndex, divided.map((hunk) => hunk.index), side, isIncluded);
  }

  /**
   * Collapses one conflict to the hunks currently selected, which is how a
   * resolution can take part of each side rather than all of one.
   */
  async applySelection(conflictIndex: number): Promise<ResolveOutcome> {
    const conflict = this.conflictAt(conflictIndex);
    if (!conflict) {
      return "gone";
    }

    const lines = assembleHunks(splitConflict(conflict), (hunkIndex, side) =>
      this.selection.isIncluded(conflictIndex, hunkIndex, side));

    return this.replaceConflict(conflictIndex, conflict, lines);
  }

  /** Writes a conflict's replacement and renumbers the pending selections after it. */
  private async replaceConflict(
    conflictIndex: number,
    conflict: ConflictSection,
    lines: readonly string[],
  ): Promise<ResolveOutcome> {
    const isApplied = await this.document.replaceLines(
      conflict.markerStartLine,
      conflict.markerEndLine,
      lines,
    );

    if (isApplied) {
      this.selection.forgetConflict(conflictIndex);
    }
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