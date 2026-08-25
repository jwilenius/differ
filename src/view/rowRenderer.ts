import type { AlignedRow, RowCell, Side, WordSpan } from "../core/types";
import type { ConflictSummary, MergeViewModel } from "./viewModel";

/** Renders the aligned rows, with an action bar above each conflict. */
export function renderGrid(model: MergeViewModel): string {
  const barByRow = new Map<number, ConflictSummary>();
  for (const conflict of model.conflicts) {
    barByRow.set(conflict.rowStart, conflict);
  }

  const parts: string[] = [];
  model.rows.forEach((row, index) => {
    const conflict = barByRow.get(index);
    if (conflict) {
      parts.push(renderActionBar(conflict));
    }
    parts.push(renderRow(row, index));
  });

  return parts.join("");
}

function renderRow(row: AlignedRow, index: number): string {
  return [
    `<div class="row kind-${row.kind}" data-row="${index}">`,
    renderCell(row.local, "local"),
    renderCell(row.base, "base"),
    renderCell(row.remote, "remote"),
    "</div>",
  ].join("");
}

function renderCell(cell: RowCell, side: Side): string {
  const isFiller = cell.text === null;
  const classes = `cell side-${side}${isFiller ? " filler" : ""}`;
  const number = cell.lineNumber === null ? "" : String(cell.lineNumber + 1);

  return [
    `<div class="num side-${side}">${number}</div>`,
    `<div class="${classes}"><span class="code">${renderText(cell)}</span></div>`,
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

function renderActionBar(conflict: ConflictSummary): string {
  const buttons = [
    button(conflict.index, "local", "Accept Left"),
    conflict.hasBase ? button(conflict.index, "base", "Accept Base") : "",
    button(conflict.index, "remote", "Accept Right"),
    button(conflict.index, "localThenRemote", "Both: L, R"),
    button(conflict.index, "remoteThenLocal", "Both: R, L"),
  ].join("");

  return [
    `<div class="action-bar" data-conflict="${conflict.index}">`,
    `<span class="conflict-title">Conflict ${conflict.index + 1}`,
    `<span class="labels">${escapeHtml(conflict.localLabel)} ↔ ${escapeHtml(conflict.remoteLabel)}</span>`,
    "</span>",
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
