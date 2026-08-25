import type { RowCell, WordSpan } from "../../core/types";
import type { ConflictSummary, ResolutionRow, ResolutionViewModel } from "../../model/resolutionView";

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
    renderCell(row.ours, "ours"),
    renderCell(row.result, "result"),
    renderCell(row.theirs, "theirs"),
    "</div>",
  ].join("");
}

function renderCell(cell: RowCell, pane: Pane): string {
  const isFiller = cell.text === null;
  const number = cell.lineNumber === null ? "" : String(cell.lineNumber + 1);

  return [
    `<div class="num pane-${pane}">${number}</div>`,
    `<div class="cell pane-${pane}${isFiller ? " filler" : ""}">`,
    `<span class="code">${renderText(cell)}</span></div>`,
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
  ].join("");

  return [
    `<div class="action-bar" data-conflict="${conflict.index}">`,
    `<span class="conflict-title">Unresolved conflict ${conflict.index + 1}</span>`,
    `<span class="actions">${buttons}</span>`,
    "</div>",
  ].join("");
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
