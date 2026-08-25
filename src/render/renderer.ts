import type { ResolutionViewModel } from "../model/resolutionView";

/** Where a UI should place the caret after the view is rebuilt. */
export interface FocusRequest {
  readonly line: number;
  readonly offset: number;
}

export interface RenderContext {
  readonly fileName: string;
  /** Hide the working-copy pane, leaving a two-pane branch-vs-incoming view. */
  readonly showResultPane: boolean;
  /** Caret to restore after an edit rebuilt the view, if any. */
  readonly focus: FocusRequest | null;
}

/**
 * Turns the host-independent model into something a UI can display. The HTML
 * renderer produces a webview document; a terminal renderer would produce lines
 * or a screen buffer, and needs no other part of this codebase to change.
 */
export interface MergeRenderer<TOutput> {
  render(model: ResolutionViewModel, context: RenderContext): TOutput;
}
