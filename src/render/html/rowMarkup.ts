import type { RowCell, WordSpan } from "../../core/types";
import type {
  ConflictSummary,
  HunkCheckbox,
  ResolutionRow,
  ResolutionViewModel,
} from "../../model/resolutionView";
import { highlightRows, type ChangeType, type RowHighlight } from "./changeHighlight";

type Pane = "ours" | "result" | "theirs";

const LOCK_ICON = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7.5" width="9" height="7" rx="1.5"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"/></svg>`;
const ACCEPT_RIGHTWARDS = "»";
const ACCEPT_LEFTWARDS = "«";

/**
 * Renders IntelliJ's merge layout as one aligned grid: branch text, its gutter,
 * the working copy's gutter and text, then the incoming gutter and text.
 */
export function renderGrid(model: ResolutionViewModel): string {
  const highlights = highlightRows(model.rows);
  const conflictByStart = new Map(model.conflicts.map((conflict) => [conflict.rowStart, conflict]));

  return [
    renderPaneHeaders(model),
    ...model.rows.map((row, index) => renderRow(row, index, highlights[index], conflictByStart.get(index) ?? null, model)),
    ...model.conflicts.map((conflict) => renderConflictMenu(conflict, model)),
  ].join("");
}

function renderPaneHeaders(model: ResolutionViewModel): string {
  return [
    `<div class="pane-header pane-ours">${LOCK_ICON}Changes from <b>${escapeHtml(model.ourLabel)}</b></div>`,
    `<div class="pane-header pane-result">Result</div>`,
    `<div class="pane-header pane-theirs">${LOCK_ICON}Changes from <b>${escapeHtml(model.theirLabel)}</b></div>`,
  ].join("");
}

/** `start` is the conflict that begins on this row, which is where its gutter arrows go. */
function renderRow(
  row: ResolutionRow,
  index: number,
  highlight: RowHighlight,
  start: ConflictSummary | null,
  model: ResolutionViewModel,
): string {
  const classes = [
    "row",
    `kind-${row.kind}`,
    row.isMarkerLine ? "marker-line" : "",
    start ? "conflict-start" : "",
  ].filter(Boolean).join(" ");
  const conflictAttribute = row.conflictIndex === null ? "" : ` data-conflict="${row.conflictIndex}"`;

  return [
    `<div class="${classes}" data-row="${index}"${conflictAttribute}>`,
    renderCell(row.ours, "ours", highlight.ours, false),
    renderGutter(row.ours, "ours", highlight.ours, start ? acceptButton(start, "local", model.ourLabel) : ""),
    renderGutter(row.result, "result", highlight.result, renderCheckbox(row.checkbox)),
    renderCell(row.result, "result", highlight.result, isEditable(row)),
    renderGutter(row.theirs, "theirs", highlight.theirs, start ? acceptButton(start, "remote", model.theirLabel) : ""),
    renderCell(row.theirs, "theirs", highlight.theirs, false),
    "</div>",
  ].join("");
}

/**
 * Only the working copy is editable, and only where it holds a real line. The
 * marker lines are resolved through the actions instead, so that a half-typed
 * marker cannot corrupt the region.
 */
function isEditable(row: ResolutionRow): boolean {
  return row.result.lineNumber !== null && !row.isMarkerLine;
}

function renderCell(cell: RowCell, pane: Pane, change: ChangeType | null, isEditableCell: boolean): string {
  const classes = [
    "cell",
    `pane-${pane}`,
    changeClass(change),
    cell.text === null ? "filler" : "",
    isEditableCell ? "editable" : "",
  ].filter(Boolean).join(" ");
  const editing = isEditableCell
    ? ` contenteditable="plaintext-only" spellcheck="false" data-line="${cell.lineNumber}"`
    : "";

  return `<div class="${classes}"${editing}><span class="code">${renderText(cell)}</span></div>`;
}

/** The line-number column beside a pane; the side gutters face the working copy, as in IntelliJ. */
function renderGutter(cell: RowCell, pane: Pane, change: ChangeType | null, controls: string): string {
  const number = cell.lineNumber === null ? "" : String(cell.lineNumber + 1);
  const content = pane === "theirs" ? `${number}${controls}` : `${controls}${number}`;
  return `<div class="num pane-${pane} ${changeClass(change)}">${content}</div>`;
}

function changeClass(change: ChangeType | null): string {
  return change ? `chg-${change}` : "";
}

/** IntelliJ's gutter arrow that pushes one side's version of the conflict into the working copy. */
function acceptButton(conflict: ConflictSummary, resolution: "local" | "remote", label: string): string {
  const arrow = resolution === "local" ? ACCEPT_RIGHTWARDS : ACCEPT_LEFTWARDS;
  const title = `Accept ${escapeHtml(label)}`;
  return `<button class="resolve gutter-action" data-conflict="${conflict.index}" data-resolution="${resolution}" title="${title}">${arrow}</button>`;
}

/**
 * The gutter control that includes one side of one hunk. It sits beside the
 * working copy so both sides' offers line up in a single column of decisions.
 */
function renderCheckbox(checkbox: HunkCheckbox | null): string {
  if (!checkbox) {
    return "";
  }

  const lines = `${checkbox.lineCount} line${checkbox.lineCount === 1 ? "" : "s"}`;
  const title = `${checkbox.isIncluded ? "Exclude" : "Include"} ${lines} from this side`;

  return [
    `<button class="hunk-box side-${checkbox.side}${checkbox.isIncluded ? " included" : ""}"`,
    ` role="checkbox" aria-checked="${checkbox.isIncluded}" title="${title}"`,
    ` data-conflict="${checkbox.conflictIndex}" data-hunk="${checkbox.hunkIndex}"`,
    ` data-side="${checkbox.side}">${checkbox.isIncluded ? "☑" : "☐"}</button>`,
  ].join("");
}

/** Wraps the changed character ranges of a line so only those words light up. */
function renderText(cell: RowCell): string {
  if (cell.text === null) {
    return "";
  }
  if (cell.spans.length === 0) {
    return escapeHtml(cell.text);
  }

  const parts: string[] = [];
  let cursor = 0;

  for (const span of clampSpans(cell.spans, cell.text.length)) {
    parts.push(escapeHtml(cell.text.slice(cursor, span.start)));
    parts.push(`<span class="word">${escapeHtml(cell.text.slice(span.start, span.end))}</span>`);
    cursor = span.end;
  }
  parts.push(escapeHtml(cell.text.slice(cursor)));

  return parts.join("");
}

function clampSpans(spans: readonly WordSpan[], length: number): WordSpan[] {
  return spans
    .map((span) => ({ start: Math.max(0, span.start), end: Math.min(length, span.end) }))
    .filter((span) => span.start < span.end);
}

/** IntelliJ's right-click menu on a conflict: every way to resolve it in one place. */
function renderConflictMenu(conflict: ConflictSummary, model: ResolutionViewModel): string {
  const items = [
    menuItem(conflict.index, "local", `${ACCEPT_RIGHTWARDS} Accept ${escapeHtml(model.ourLabel)}`),
    menuItem(conflict.index, "remote", `${ACCEPT_LEFTWARDS} Accept ${escapeHtml(model.theirLabel)}`),
    menuItem(conflict.index, "localThenRemote", "Keep both"),
    conflict.hasBase ? menuItem(conflict.index, "base", "Revert to base") : "",
    renderApplyItem(conflict),
  ].join("");

  return `<div class="context-menu" data-menu="${conflict.index}" role="menu" hidden>${renderSplitHint(conflict)}${items}</div>`;
}

/** Commits whatever the gutter checkboxes currently select, rather than a whole side. */
function renderApplyItem(conflict: ConflictSummary): string {
  if (conflict.hunkCount === 0) {
    return "";
  }

  const lines = `${conflict.selectedLineCount} line${conflict.selectedLineCount === 1 ? "" : "s"}`;
  return [
    `<hr><button class="apply-selection" role="menuitem" data-conflict="${conflict.index}"`,
    ` title="Replace this conflict with the lines ticked in the gutter">`,
    `Apply selection (${lines})</button>`,
  ].join("");
}

function renderSplitHint(conflict: ConflictSummary): string {
  if (conflict.hunkCount < 2) {
    return "";
  }
  return `<div class="split-hint">${conflict.hunkCount} parts — tick the gutter to take them separately</div>`;
}

function menuItem(conflictIndex: number, resolution: string, label: string): string {
  return `<button class="resolve" role="menuitem" data-conflict="${conflictIndex}" data-resolution="${resolution}">${label}</button>`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
