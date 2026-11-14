import type { WordSpan } from "../../core/types";
import type { ResultPosition } from "../../model/mergeHistory";
import type { MergeSide } from "../../model/mergeChunks";
import type { MergeState, MergeTally } from "../../model/mergeSession";
import type { ChunkTint, ChunkView } from "../../model/mergeView";
import type { HighlightedText } from "../../model/syntaxTokens";
import type { LineRange } from "../../model/twoWayDiff";
import { renderCode, renderTokenStyles } from "./codeMarkup";
import { escapeHtml } from "./webviewMarkup";

export interface MergeViewInput {
  readonly state: MergeState;
  readonly chunks: readonly ChunkView[];
  readonly tally: MergeTally;
  readonly leftHighlight: HighlightedText;
  readonly rightHighlight: HighlightedText;
  readonly resultHighlight: HighlightedText;
}

/** What the result pane's markup depends on. */
export type MergeResultInput = Pick<MergeViewInput, "state" | "chunks" | "resultHighlight">;

/** A line's text as the page shows it, and the markup of its `.code`. */
export interface LineMarkup {
  readonly text: string;
  readonly html: string;
}

export interface MergeViewRenderContext {
  readonly nonce: string;
  readonly cspSource: string;
  readonly title: string;
  /** Stylesheets and scripts in load order. */
  readonly styleUris: readonly string[];
  readonly scriptUris: readonly string[];
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly resultPath: string;
  /** During a rebase git's sides are reversed, which the toolbar warns about. */
  readonly isSidesSwapped: boolean;
  /** Numbers the page; the client stamps it on every message, so the host can tell a replaced page's messages apart. */
  readonly page: number;
  /**
   * Where the client puts the caret once loaded: where an undo or redo changed the result, or where the page it
   * replaces had it; null leaves focus alone.
   */
  readonly caret: ResultPosition | null;
}

/** Published as JSON in `#merge[data-merge]`; ranges are `[start, end)` line pairs. */
export interface MergeClientData {
  readonly chunks: readonly {
    readonly tint: ChunkTint;
    readonly isResolved: boolean;
    readonly isLeftPending: boolean;
    readonly isRightPending: boolean;
    readonly left: readonly [number, number];
    readonly right: readonly [number, number];
    readonly result: readonly [number, number];
  }[];
  readonly leftLineCount: number;
  readonly rightLineCount: number;
  readonly resultLineCount: number;
}

type Pane = MergeSide | "result";

/** What one pane draws: its lines, and per line the chunk tint, the 1px gap markers, changed words and gutter actions. */
interface PaneLayout {
  readonly pane: Pane;
  /** Bare lines: a `\r` would reach the page as a line break, so callers normalize line endings first. */
  readonly lines: readonly string[];
  readonly highlight: HighlightedText;
  readonly tints: ReadonlyMap<number, ChunkTint>;
  /** Empty ranges by the line they precede; the line count stands for "after the last line". */
  readonly gaps: ReadonlyMap<number, ChunkTint>;
  readonly words: ReadonlyMap<number, readonly WordSpan[]>;
  /** Chunk indexes whose apply/ignore buttons sit on a line; a gap before the last line shares it with a gap ending the file. */
  readonly actions: ReadonlyMap<number, readonly number[]>;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/;

const LOCK_ICON = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7.5" width="9" height="7" rx="1.5"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"/></svg>`;

/**
 * Renders IntelliJ's merge dialog: the left version, the result and the right
 * version side by side, joined by connector strips, with apply (» «) and
 * ignore (×) buttons in the side gutters. The result is editable.
 *
 * Client contract: `#merge[data-merge]` holds {@link MergeClientData} and `#merge[data-page]` the page number;
 * `#merge[data-caret-line][data-caret-column]`, when present, the result position the client puts the caret at;
 * `style#result-styles` holds the result's token styles, which the client replaces with re-highlighted ones;
 * scrollers `#scroll-left`, `#scroll-result`, `#scroll-right` contain one
 * `.line` per text line; `svg#connectors-left` / `svg#connectors-right` sit in
 * the strips; a result `.line` holds `.num` and `.code[data-line]`, which the
 * client also builds when it splits, joins or pastes lines (classes from `mergeLines.js`); buttons
 * `button.act[data-chunk][data-side][data-action]`, `#prev`, `#next`,
 * `button[data-non-conflicting]`, `button[data-accept]`, `#cancel`, `#apply`.
 */
export class HtmlMergeViewRenderer {
  render(input: MergeViewInput, context: MergeViewRenderContext): string {
    if (!NONCE_PATTERN.test(context.nonce)) {
      throw new Error("Merge renderer needs a base64-style nonce of at least 16 characters");
    }
    const { nonce } = context;
    const csp = ["default-src 'none'", `style-src ${context.cspSource} 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].join("; ");
    const sideTokenStyles = renderTokenStyles(input.leftHighlight.styles, "left") + renderTokenStyles(input.rightHighlight.styles, "right");
    const styles = context.styleUris.map((uri) => `<link href="${escapeHtml(uri)}" rel="stylesheet">`).join("\n");
    const scripts = context.scriptUris.map((uri) => `<script nonce="${nonce}" src="${escapeHtml(uri)}"></script>`).join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
${styles}
<style nonce="${nonce}">${sideTokenStyles}</style>
<style nonce="${nonce}" id="result-styles">${renderTokenStyles(input.resultHighlight.styles, "result")}</style>
<title>${escapeHtml(context.title)}</title>
</head>
<body>
${renderToolbar(input, context)}
<main class="merge" id="merge" data-page="${context.page}"${caretAttributes(context.caret)} data-merge="${escapeHtml(JSON.stringify(mergeClientData(input.state, input.chunks)))}">
${renderSideHeader("left", context.leftLabel)}
<div class="strip-header"></div>
<div class="pane-header pane-result"><b>Result</b><span class="path">${escapeHtml(context.resultPath)}</span></div>
<div class="strip-header"></div>
${renderSideHeader("right", context.rightLabel)}
${renderPane(layoutSide(input, "left"))}
<div class="strip"><svg id="connectors-left" aria-hidden="true"></svg></div>
${renderPane(layoutResult(input))}
<div class="strip"><svg id="connectors-right" aria-hidden="true"></svg></div>
${renderPane(layoutSide(input, "right"))}
</main>
${renderFooter()}
${scripts}
</body>
</html>`;
  }
}

/** The chunk layout the client draws from; result edits change only the result ranges and line count. */
export function mergeClientData(state: MergeState, chunks: readonly ChunkView[]): MergeClientData {
  const pair = (range: LineRange): readonly [number, number] => [range.start, range.end];
  return {
    chunks: chunks.map((chunk) => ({
      tint: chunk.tint,
      isResolved: chunk.isResolved,
      isLeftPending: chunk.left.resolution === "pending",
      isRightPending: chunk.right.resolution === "pending",
      left: pair(chunk.left.range),
      right: pair(chunk.right.range),
      result: pair(chunk.result),
    })),
    leftLineCount: state.leftLines.length,
    rightLineCount: state.rightLines.length,
    resultLineCount: state.resultLines.length,
  };
}

function caretAttributes(caret: ResultPosition | null): string {
  return caret === null ? "" : ` data-caret-line="${caret.line}" data-caret-column="${caret.column}"`;
}

function renderToolbar(input: MergeViewInput, context: MergeViewRenderContext): string {
  const hasPendingChanges = input.chunks.some((chunk) => !chunk.isResolved && chunk.tint !== "conflict");
  const disabled = hasPendingChanges ? "" : " disabled";
  const swapWarning = context.isSidesSwapped
    ? `<span class="warning" title="During a rebase git replays your commits onto the other branch, so the sides are reversed">⚠ Sides are reversed during a rebase</span>`
    : "";

  return `<header class="toolbar">
  <span class="nav">
    <button id="prev" class="tool" title="Previous Change (Shift+F7)" aria-label="Previous change">↑</button>
    <button id="next" class="tool" title="Next Change (F7)" aria-label="Next change">↓</button>
  </span>
  <span class="separator"></span>
  <span class="label">Apply non-conflicting changes:</span>
  <button class="tool text-only" data-non-conflicting="left" title="Apply non-conflicting changes from the left side"${disabled}>» Left</button>
  <button class="tool text-only" data-non-conflicting="all" title="Apply all non-conflicting changes"${disabled}>»« All</button>
  <button class="tool text-only" data-non-conflicting="right" title="Apply non-conflicting changes from the right side"${disabled}>« Right</button>
  ${swapWarning}
  <span class="status">${statusText(input.tally)}</span>
</header>`;
}

/** IntelliJ's wording: "7 changes. 4 conflicts.", counting conflicts apart. */
function statusText(tally: MergeTally): string {
  if (tally.changes === 0 && tally.conflicts === 0) {
    return "All changes have been processed.";
  }
  const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
  return `${plural(tally.changes, "change")}. ${plural(tally.conflicts, "conflict")}.`;
}

function renderSideHeader(side: MergeSide, label: string): string {
  return `<div class="pane-header pane-${side}">${LOCK_ICON}<span>Changes from <b>${escapeHtml(label)}</b></span></div>`;
}

function renderFooter(): string {
  return `<footer class="footer">
  <button class="button" data-accept="left">Accept Left</button>
  <button class="button" data-accept="right">Accept Right</button>
  <span class="spacer"></span>
  <button class="button" id="cancel">Cancel</button>
  <button class="button primary" id="apply">Apply</button>
</footer>`;
}

/** A side pane highlights a chunk while its own change is still to be decided. */
function layoutSide(input: MergeViewInput, side: MergeSide): PaneLayout {
  const lines = side === "left" ? input.state.leftLines : input.state.rightLines;
  const highlight = side === "left" ? input.leftHighlight : input.rightHighlight;
  const pending = input.chunks.filter((chunk) => chunk[side].resolution === "pending");
  const actions = new Map<number, number[]>();
  for (const chunk of pending) {
    const line = actionLine(chunk[side].range, lines.length);
    actions.set(line, [...(actions.get(line) ?? []), chunk.index]);
  }

  return {
    pane: side,
    lines,
    highlight,
    ...tintRanges(pending.map((chunk) => ({ range: chunk[side].range, tint: chunk.tint }))),
    words: wordsByLine(pending.flatMap((chunk) => chunk[side].words)),
    actions,
  };
}

/** The markup of every result line, as the page draws it; re-highlighting after an edit compares it line by line. */
export function resultLineMarkup(input: MergeResultInput): LineMarkup[] {
  const layout = layoutResult(input);
  return layout.lines.map((_, index) => lineMarkup(layout, index));
}

/** The result highlights every chunk still unresolved. */
function layoutResult(input: MergeResultInput): PaneLayout {
  const unresolved = input.chunks.filter((chunk) => !chunk.isResolved);
  return {
    pane: "result",
    lines: input.state.resultLines,
    highlight: input.resultHighlight,
    ...tintRanges(unresolved.map((chunk) => ({ range: chunk.result, tint: chunk.tint }))),
    words: wordsByLine(unresolved.flatMap((chunk) => chunk.resultWords)),
    actions: new Map(),
  };
}

/** Buttons for an empty range go on the line after the gap, or on the last line when the gap ends the file. */
function actionLine(range: LineRange, lineCount: number): number {
  return Math.min(range.start, lineCount - 1);
}

function tintRanges(ranges: readonly { readonly range: LineRange; readonly tint: ChunkTint }[]): Pick<PaneLayout, "tints" | "gaps"> {
  const tints = new Map<number, ChunkTint>();
  const gaps = new Map<number, ChunkTint>();
  for (const { range, tint } of ranges) {
    if (range.start === range.end) {
      gaps.set(range.start, tint);
    }
    for (let line = range.start; line < range.end; line++) {
      tints.set(line, tint);
    }
  }
  return { tints, gaps };
}

function wordsByLine(entries: readonly { readonly line: number; readonly spans: readonly WordSpan[] }[]): Map<number, readonly WordSpan[]> {
  return new Map(entries.map((entry) => [entry.line, entry.spans]));
}

function renderPane(layout: PaneLayout): string {
  const lines = layout.lines.map((_, index) => renderLine(layout, index)).join("");
  // One line holding two chunks' buttons widens the whole gutter, which would otherwise jut out there.
  const isDouble = [...layout.actions.values()].some((chunks) => chunks.length > 1);
  const classes = `scroller pane-${layout.pane}${isDouble ? " double-acts" : ""}`;
  return `<div class="${classes}" id="scroll-${layout.pane}"><div class="lines">${lines}</div></div>`;
}

function lineMarkup(layout: PaneLayout, index: number): LineMarkup {
  const text = layout.lines[index];
  return { text, html: renderCode(text, layout.highlight.lines[index] ?? [], layout.words.get(index) ?? [], layout.pane) };
}

function renderLine(layout: PaneLayout, index: number): string {
  const tint = layout.tints.get(index);
  const gapBefore = layout.gaps.get(index);
  const gapAfter = index === layout.lines.length - 1 ? layout.gaps.get(layout.lines.length) : undefined;
  const classes = [
    "line",
    tint ? `chg-${tint}` : "",
    gapBefore ? `gap-before gap-${gapBefore}` : "",
    gapAfter ? `gap-after gap-${gapAfter}` : "",
  ].filter(Boolean).join(" ");
  const code = lineMarkup(layout, index).html;
  const number = `<span class="num">${index + 1}</span>`;

  switch (layout.pane) {
    case "left":
      return `<div class="${classes}"><span class="code">${code}</span><span class="gutter">${renderActions(layout, index)}${number}</span></div>`;
    case "right":
      return `<div class="${classes}"><span class="gutter">${number}${renderActions(layout, index)}</span><span class="code">${code}</span></div>`;
    case "result":
      return `<div class="${classes}">${number}<span class="code" contenteditable="plaintext-only" spellcheck="false" data-line="${index}">${code}</span></div>`;
  }
}

/** IntelliJ's gutter: `× »` beside the left pane, `« ×` beside the right, always pointing at the result. */
function renderActions(layout: PaneLayout, line: number): string {
  const chunks = layout.actions.get(line) ?? [];
  return `<span class="acts">${chunks.map((chunk) => renderChunkActions(layout.pane, chunk)).join("")}</span>`;
}

function renderChunkActions(side: Pane, chunk: number): string {
  const apply = `<button class="act apply" data-chunk="${chunk}" data-side="${side}" data-action="apply" title="Accept" aria-label="Accept">${side === "left" ? "»" : "«"}</button>`;
  const ignore = `<button class="act ignore" data-chunk="${chunk}" data-side="${side}" data-action="ignore" title="Ignore" aria-label="Ignore">×</button>`;
  return side === "left" ? ignore + apply : apply + ignore;
}
