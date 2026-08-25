import type { RowCell, WordSpan } from "../../core/types";
import type {
  ConflictSummary,
  HunkCheckbox,
  ResolutionRow,
  ResolutionViewModel,
} from "../../model/resolutionView";

type Pane = "ours" | "result" | "theirs";

/** Renders the aligned rows, with an action bar above each unresolved conflict. */
export function renderGrid(model: ResolutionViewModel): string {
  const barByRow = new Map<number, ConflictSummary>();
  for (const conflict of model.conflicts) {
    barByRow.set(conflict.rowStart, conflict);
  }

  const parts: string[] = [];
  model.rows.forEach((row, index) => {
    const conflict = barByRow.get(index);
    if (conflict) {
      parts.push(renderActionBar(conflict, model));
    }
    parts.push(renderRow(row, index));
  });

  return parts.join("");
}

function renderRow(row: ResolutionRow, index: number): string {
  const markerClass = row.isMarkerLine ? " marker-line" : "";

  return [
    `<div class="row kind-${row.kind}${markerClass}" data-row="${index}">`,
    renderCell(row.ours, "ours", false),
    renderCell(row.result, "result", isEditable(row), row.checkbox),
    renderCell(row.theirs, "theirs", false),
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

function renderCell(
  cell: RowCell,
  pane: Pane,
  isEditableCell: boolean,
  checkbox: HunkCheckbox | null = null,
): string {
  const isFiller = cell.text === null;
  const number = cell.lineNumber === null ? "" : String(cell.lineNumber + 1);
  const editing = isEditableCell
    ? ` contenteditable="plaintext-only" spellcheck="false" data-line="${cell.lineNumber}"`
    : "";

  return [
    `<div class="num pane-${pane}">${renderCheckbox(checkbox)}${number}</div>`,
    `<div class="cell pane-${pane}${isFiller ? " filler" : ""}${isEditableCell ? " editable" : ""}"${editing}>`,
    `<span class="code">${renderText(cell)}</span></div>`,
  ].join("");
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

function renderActionBar(conflict: ConflictSummary, model: ResolutionViewModel): string {
  const buttons = [
    button(conflict.index, "local", `Take ${escapeHtml(model.ourLabel)}`),
    conflict.hasBase ? button(conflict.index, "base", "Revert to base") : "",
    button(conflict.index, "remote", `Take ${escapeHtml(model.theirLabel)}`),
    button(conflict.index, "localThenRemote", "Keep both"),
    renderApplyButton(conflict),
  ].join("");

  return [
    `<div class="action-bar" data-conflict="${conflict.index}">`,
    `<span class="conflict-title">Unresolved conflict ${conflict.index + 1}</span>`,
    renderSplitHint(conflict),
    `<span class="actions">${buttons}</span>`,
    "</div>",
  ].join("");
}

/** Commits whatever the gutter checkboxes currently select, rather than a whole side. */
function renderApplyButton(conflict: ConflictSummary): string {
  if (conflict.hunkCount === 0) {
    return "";
  }

  const lines = `${conflict.selectedLineCount} line${conflict.selectedLineCount === 1 ? "" : "s"}`;
  return [
    `<button class="apply-selection" data-conflict="${conflict.index}"`,
    ` title="Replace this conflict with the lines ticked in the gutter">`,
    `Apply selection (${lines})</button>`,
  ].join("");
}

function renderSplitHint(conflict: ConflictSummary): string {
  if (conflict.hunkCount < 2) {
    return "";
  }
  return `<span class="split-hint">${conflict.hunkCount} parts — tick the gutter to take them separately</span>`;
}

function button(conflictIndex: number, resolution: string, label: string): string {
  return `<button class="resolve" data-conflict="${conflictIndex}" data-resolution="${resolution}">${label}</button>`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
