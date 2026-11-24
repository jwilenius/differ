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
  /** The chunks whose apply/ignore buttons sit on a line; a gap before the last line shares it with a gap ending the file. */
  readonly actions: ReadonlyMap<number, readonly ChunkAction[]>;
}

/** A chunk's apply/ignore buttons on one side, and what their tooltips call it: `left change 3`, `the right side of conflict 1`. */
interface ChunkAction {
  readonly chunk: number;
  readonly subject: string;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/;

const LOCK_ICON = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7.5" width="9" height="7" rx="1.5"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"/></svg>`;
const LOCK_TITLE = "Read-only: only the result can be edited";
const NON_CONFLICTING_LABEL_TITLE = "Apply every pending change that does not conflict, from the left side, the right side or both";
const NOTHING_NON_CONFLICTING_TITLE = "Nothing to apply: no non-conflicting change is pending";
const CANCEL_TITLE = "Close without writing the file; asks first when the merge view has changes";

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
${renderResultHeader(context.resultPath)}
<div class="strip-header"></div>
${renderSideHeader("right", context.rightLabel)}
${renderPane(layoutSide(input, "left"))}
<div class="strip"><svg id="connectors-left" aria-hidden="true"></svg></div>
${renderPane(layoutResult(input))}
<div class="strip"><svg id="connectors-right" aria-hidden="true"></svg></div>
${renderPane(layoutSide(input, "right"))}
</main>
${renderFooter(input.tally, context)}
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
  const nonConflicting = (scope: string, title: string, label: string): string =>
    `<button class="tool text-only" data-non-conflicting="${scope}" title="${hasPendingChanges ? title : NOTHING_NON_CONFLICTING_TITLE}"${hasPendingChanges ? "" : " disabled"}>${label}</button>`;
  const swapWarning = context.isSidesSwapped
    ? `<span class="warning" title="During a rebase git replays your commits onto the other branch, so the sides are reversed">⚠ Sides are reversed during a rebase</span>`
    : "";

  return `<header class="toolbar">
  <span class="nav">
    <button id="prev" class="tool" title="Previous Change (Shift+F7)" aria-label="Previous change">↑</button>
    <button id="next" class="tool" title="Next Change (F7)" aria-label="Next change">↓</button>
  </span>
  <span class="separator"></span>
  <span class="label" title="${NON_CONFLICTING_LABEL_TITLE}">Apply non-conflicting changes:</span>
  ${nonConflicting("left", "Apply non-conflicting changes from the left side", "» Left")}
  ${nonConflicting("all", "Apply all non-conflicting changes", "»« All")}
  ${nonConflicting("right", "Apply non-conflicting changes from the right side", "« Right")}
  ${swapWarning}
  <span class="status" title="${tallyTooltip(input.tally)}">${statusText(input.tally)}</span>
</header>`;
}

/** IntelliJ's wording: "7 changes. 4 conflicts.", counting conflicts apart. */
function statusText(tally: MergeTally): string {
  if (tally.changes === 0 && tally.conflicts === 0) {
    return "All changes have been processed.";
  }
  return `${plural(tally.changes, "change")}. ${plural(tally.conflicts, "conflict")}.`;
}

/** The status's tooltip: what is left to resolve, and what the two counts mean. */
function tallyTooltip(tally: MergeTally): string {
  if (tally.changes === 0 && tally.conflicts === 0) {
    return "Every change and conflict has been applied or ignored";
  }
  return `Still to resolve: ${plural(tally.changes, "change")}, blocks only one side changed or both changed alike, and ${plural(tally.conflicts, "conflict")}, blocks both sides changed differently`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function renderSideHeader(side: MergeSide, label: string): string {
  const arrow = side === "left" ? "»" : "«";
  const title = `The ${side} side, read-only: changes from ${label}. ${arrow} in its gutter applies a change to the result, × ignores it`;
  const lock = `<span class="lock" role="img" aria-label="Read-only" title="${LOCK_TITLE}">${LOCK_ICON}</span>`;
  return `<div class="pane-header pane-${side}" title="${escapeHtml(title)}">${lock}<span>Changes from <b>${escapeHtml(label)}</b></span></div>`;
}

/** The tooltip shows the full path, which the header may cut short. */
function renderResultHeader(resultPath: string): string {
  const title = `The result, editable: ${resultPath}\nApply writes it to this file`;
  return `<div class="pane-header pane-result" title="${escapeHtml(title)}"><b>Result</b><span class="path">${escapeHtml(resultPath)}</span></div>`;
}

function renderFooter(tally: MergeTally, context: MergeViewRenderContext): string {
  const isComplete = tally.changes === 0 && tally.conflicts === 0;
  const applyTitle = isComplete
    ? "Write the result to the file, save it and stage it (git add), then close"
    : "Write the result to the file and save it, then close; asks first while changes are unresolved, and does not stage the file";
  const acceptTitle = (side: MergeSide, label: string): string =>
    escapeHtml(`Replace the whole result with the ${side} side (${label}), discarding edits and resolving every change`);
  return `<footer class="footer">
  <button class="button" data-accept="left" title="${acceptTitle("left", context.leftLabel)}">Accept Left</button>
  <button class="button" data-accept="right" title="${acceptTitle("right", context.rightLabel)}">Accept Right</button>
  <span class="spacer"></span>
  <button class="button" id="cancel" title="${CANCEL_TITLE}">Cancel</button>
  <button class="button primary" id="apply" title="${applyTitle}">Apply</button>
</footer>`;
}

/** A side pane highlights a chunk while its own change is still to be decided. */
function layoutSide(input: MergeViewInput, side: MergeSide): PaneLayout {
  const lines = side === "left" ? input.state.leftLines : input.state.rightLines;
  const highlight = side === "left" ? input.leftHighlight : input.rightHighlight;
  const pending = input.chunks.filter((chunk) => chunk[side].resolution === "pending");
  const names = nameChunks(input.chunks);
  const actions = new Map<number, ChunkAction[]>();
  for (const chunk of pending) {
    const line = actionLine(chunk[side].range, lines.length);
    const name = names[chunk.index];
    const subject = chunk.tint === "conflict" ? `the ${side} side of ${name}` : `${side} ${name}`;
    actions.set(line, [...(actions.get(line) ?? []), { chunk: chunk.index, subject }]);
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

/**
 * Names each chunk by its place in file order among the changes or among the conflicts, `change 3` or `conflict 1`,
 * indexed like `chunks`; resolved chunks count too, so a name stays put while the status counts only unresolved ones.
 */
function nameChunks(chunks: readonly ChunkView[]): readonly string[] {
  let changes = 0;
  let conflicts = 0;
  return chunks.map((chunk) => (chunk.tint === "conflict" ? `conflict ${++conflicts}` : `change ${++changes}`));
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
  const number = `<span class="num" title="Line ${index + 1}">${index + 1}</span>`;

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
  const actions = layout.actions.get(line) ?? [];
  return `<span class="acts">${actions.map((action) => renderChunkActions(layout.pane, action)).join("")}</span>`;
}

function renderChunkActions(side: Pane, action: ChunkAction): string {
  const { chunk, subject } = action;
  const apply = `<button class="act apply" data-chunk="${chunk}" data-side="${side}" data-action="apply" title="Accept ${subject}: apply it to the result" aria-label="Accept ${subject}">${side === "left" ? "»" : "«"}</button>`;
  const ignore = `<button class="act ignore" data-chunk="${chunk}" data-side="${side}" data-action="ignore" title="Ignore ${subject}: leave the result as it is" aria-label="Ignore ${subject}">×</button>`;
  return side === "left" ? ignore + apply : apply + ignore;
}
