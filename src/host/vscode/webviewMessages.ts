import type { Resolution } from "../../core/mergeResolver";
import type { HunkSide } from "../../model/hunkSplitter";

import type { FocusRequest } from "../../render/renderer";

export type { FocusRequest };

export type WebviewMessage =
  | { readonly type: "resolve"; readonly conflictIndex: number; readonly resolution: Resolution }
  | { readonly type: "editLine"; readonly line: number; readonly text: string; readonly focus: FocusRequest }
  | { readonly type: "splitLine"; readonly line: number; readonly offset: number; readonly focus: FocusRequest }
  | { readonly type: "joinWithPrevious"; readonly line: number; readonly focus: FocusRequest }
  | {
    readonly type: "toggleHunk";
    readonly conflictIndex: number;
    readonly hunkIndex: number;
    readonly side: HunkSide;
  }
  | { readonly type: "applySelection"; readonly conflictIndex: number };
