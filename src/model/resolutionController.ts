import { parseConflicts } from "../core/conflictParser";
import { resolvedLines, type Resolution } from "../core/mergeResolver";
import { readMergeSources, type MergeSources } from "../git/gitMergeSources";
import type { ConflictSection } from "../core/types";
import type { MergeDocument } from "./mergeDocument";
import { buildResolutionView, type ResolutionViewModel, type ViewOptions } from "./resolutionView";

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