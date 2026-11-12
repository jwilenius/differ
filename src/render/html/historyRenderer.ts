import { buildHistoryGraph, filterHistoryGraph } from "../../model/historyGraph";
import type { GraphSegment, HistoryGraphRow, VisibleGraphRow } from "../../model/historyGraph";
import { describeResolvedBase, shortHash as abbreviate } from "../../model/historyLabels";
import type {
  ComparisonFile,
  ComparisonResult,
  FileStatus,
  HistoryCommit,
  HistoryData,
  HistoryOperation,
  HistoryRef,
  HistoryRefKind,
  HistoryState,
} from "../../model/historyTypes";
import type { WebviewAssets } from "./htmlRenderer";
import { escapeHtml } from "./rowMarkup";

/** Rows rendered initially and added by each Load more. */
export const HISTORY_PAGE_SIZE = 200;

export interface HistoryRepositoryOption {
  /** Opaque host-issued ID; never a path. */
  readonly id: string;
  readonly name: string;
}

/** View-only choices that never change the selection or comparison. */
export interface HistoryPresentation {
  readonly search: string;
  /** Tip OID of the branch filter; null shows all branches. */
  readonly branchOid: string | null;
  readonly focusedOid: string | null;
  readonly rowLimit: number;
}

/** Everything besides the domain state that one render needs; computed by the host. */
export interface HistoryRenderContext {
  readonly assets: WebviewAssets;
  readonly nonce: string;
  readonly repositories: readonly HistoryRepositoryOption[];
  readonly activeRepositoryId: string | null;
  readonly presentation: HistoryPresentation;
  /** OIDs passing the host's search and branch filters, in graph order. */
  readonly visibleOids: readonly string[];
  /** Selected commits the filters currently hide. */
  readonly hiddenSelectedCount: number;
  /** Publication counter every client intent must echo. */
  readonly wireRevision: number;
}

/** Published as JSON in `body[data-history]` for the client script. */
export interface HistoryPublicState {
  readonly revision: number;
  readonly repositoryId: string | null;
  /** Full selection, including commits hidden by filters or paging. */
  readonly selectedOids: readonly string[];
  /** Rows present in the table, in display order. */
  readonly renderedOids: readonly string[];
  readonly focusedOid: string | null;
  readonly search: string;
  readonly branchOid: string | null;
  readonly rowLimit: number;
  /** Snapshot whose files are listed; null unless the comparison is ready. */
  readonly snapshotId: string | null;
}

/** Lookups shared by the markup functions of one render. */
interface HistoryView {
  readonly state: HistoryState;
  readonly context: HistoryRenderContext;
  readonly commits: ReadonlyMap<string, HistoryCommit>;
  readonly refs: ReadonlyMap<string, readonly HistoryRef[]>;
  readonly selected: ReadonlySet<string>;
}

type StatusTone = "info" | "busy" | "warning" | "error";

interface StatusLine {
  readonly text: string;
  readonly tone: StatusTone;
}

const LANE_WIDTH = 12;
const ROW_HEIGHT = 22;
const NODE_RADIUS = 3.5;
const LANE_COLOR_COUNT = 8;
const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/;
const ISO_MINUTE_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

const REF_CLASSES: Readonly<Record<HistoryRefKind, string>> = {
  head: "ref-head",
  localBranch: "ref-local",
  remoteBranch: "ref-remote",
  tag: "ref-tag",
};

const FAILED_OPERATION_LABELS: Readonly<Record<HistoryOperation, string>> = {
  load: "load history",
  resolveBase: "resolve the base",
  compare: "compare",
};

const FILE_STATUS_LABELS: Readonly<Record<FileStatus, { readonly letter: string; readonly name: string }>> = {
  added: { letter: "A", name: "Added" },
  deleted: { letter: "D", name: "Deleted" },
  modified: { letter: "M", name: "Modified" },
  renamed: { letter: "R", name: "Renamed" },
  typeChanged: { letter: "T", name: "Type changed" },
};

/**
 * Renders the history panel in IntelliJ's Git Log layout: toolbar, status
 * line, graph + commit table, and a side column with changed files, replay
 * order and the focused commit's details. Every Git string is escaped; the
 * client reads its state only from `data-history`.
 *
 * Client contract: controls `#history-repository` (select, root IDs),
 * `#history-choose-repository`, `#history-refresh`, `#history-search`,
 * `#history-branch` (select, `""` = all), `#history-base-automatic`,
 * `#history-base-input` + `#history-base-pin`, `#history-clear-selection`,
 * `#history-load-more[data-row-limit]`; rows `#history-commits tr.commit-row[data-oid]`;
 * `select.mainline-select[data-oid]` (value = one-based parent);
 * file buttons `button.file-row[data-snapshot-id][data-file-id]`.
 */
export class HtmlHistoryRenderer {
  private graphSource: HistoryData | null = null;
  private graphRows: readonly HistoryGraphRow[] = [];

  render(state: HistoryState, context: HistoryRenderContext): string {
    if (!NONCE_PATTERN.test(context.nonce)) {
      throw new Error("History renderer needs a base64-style nonce of at least 16 characters");
    }
    const view = createView(state, context);
    const visibleRows = filterHistoryGraph(this.graphFor(state.history), context.visibleOids);
    const renderedRows = visibleRows.slice(0, rowLimit(context));
    const publicState = createPublicState(state, context, renderedRows);
    const { assets, nonce } = context;
    const csp = [
      "default-src 'none'",
      `style-src ${assets.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<link href="${escapeHtml(assets.styleUri)}" rel="stylesheet">
<title>Git History</title>
</head>
<body data-history="${escapeHtml(JSON.stringify(publicState))}">
${renderToolbar(view)}
${renderStatus(view)}
<main class="history-layout">
${renderCommitPane(view, renderedRows, visibleRows.length)}
<aside class="detail-pane">
${renderFiles(view)}
${renderReplay(view)}
${renderDetails(view)}
</aside>
</main>
<script nonce="${nonce}" src="${escapeHtml(assets.scriptUri)}"></script>
</body>
</html>`;
  }

  /** The layout covers the whole loaded graph, so it is reused until metadata is reloaded. */
  private graphFor(history: HistoryData | null): readonly HistoryGraphRow[] {
    if (history !== this.graphSource) {
      this.graphSource = history;
      this.graphRows = history ? buildHistoryGraph(history.commits) : [];
    }
    return this.graphRows;
  }
}

function createView(state: HistoryState, context: HistoryRenderContext): HistoryView {
  const commits = new Map((state.history?.commits ?? []).map((commit) => [commit.oid, commit]));
  const refs = new Map<string, HistoryRef[]>();
  for (const ref of state.history?.refs ?? []) {
    refs.set(ref.oid, [...(refs.get(ref.oid) ?? []), ref]);
  }
  return { state, context, commits, refs, selected: new Set(state.selectedOids) };
}

function rowLimit(context: HistoryRenderContext): number {
  const limit = context.presentation.rowLimit;
  return Number.isInteger(limit) && limit > 0 ? limit : HISTORY_PAGE_SIZE;
}

function createPublicState(state: HistoryState, context: HistoryRenderContext, rows: readonly VisibleGraphRow[]): HistoryPublicState {
  const { presentation } = context;
  return {
    revision: context.wireRevision,
    repositoryId: context.activeRepositoryId,
    selectedOids: state.selectedOids,
    renderedOids: rows.map((entry) => entry.row.oid),
    focusedOid: presentation.focusedOid,
    search: presentation.search,
    branchOid: presentation.branchOid,
    rowLimit: rowLimit(context),
    snapshotId: state.comparison?.kind === "ready" ? state.comparison.snapshotId : null,
  };
}

// ---------------------------------------------------------------- toolbar

function renderToolbar(view: HistoryView): string {
  return `<header class="history-toolbar" role="toolbar" aria-label="History controls">
${renderRepositoryPicker(view.context)}
<input id="history-search" class="search" type="search" placeholder="Search subject or hash" aria-label="Search commits by subject or hash" value="${escapeHtml(view.context.presentation.search)}">
${renderBranchFilter(view)}
${renderBaseControls(view)}
${renderSelectionSummary(view)}
</header>`;
}

function renderRepositoryPicker(context: HistoryRenderContext): string {
  const options = context.repositories
    .map((repository) => option(repository.id, repository.name, repository.id === context.activeRepositoryId))
    .join("");
  const isEmpty = context.repositories.length === 0;
  const select = isEmpty
    ? `<select id="history-repository" aria-label="Repository" disabled><option value="">No repository</option></select>`
    : `<select id="history-repository" aria-label="Repository">${options}</select>`;
  return `<span class="toolbar-group">${select}<button id="history-choose-repository" class="tool" title="Open another repository folder">Open…</button><button id="history-refresh" class="tool" title="Reload history" aria-label="Refresh history">⟳</button></span>`;
}

function renderBranchFilter(view: HistoryView): string {
  const branchOid = view.context.presentation.branchOid;
  const branches = (view.state.history?.refs ?? []).filter((ref) => ref.kind !== "tag");
  // Several refs can share a tip; mark only the first so the browser shows a stable choice.
  const selectedIndex = branches.findIndex((ref) => ref.oid === branchOid);
  const fallback = branchOid !== null && selectedIndex < 0 ? option(branchOid, abbreviate(branchOid), true) : "";
  const options = branches.map((ref, index) => option(ref.oid, ref.name, index === selectedIndex));
  return `<select id="history-branch" aria-label="Branch filter">${option("", "All branches", branchOid === null)}${fallback}${options.join("")}</select>`;
}

function renderBaseControls(view: HistoryView): string {
  const base = view.state.base;
  const isAutomatic = base.kind === "automatic";
  const typed = isAutomatic ? "" : base.label;
  return `<span class="toolbar-group base-control" role="group" aria-label="Comparison base">
<span class="label">Base:</span>
<button id="history-base-automatic" class="tool" aria-pressed="${isAutomatic}">Automatic</button>
<input id="history-base-input" type="text" placeholder="Commit, branch or tag" aria-label="Pin base to a commit, branch or tag" value="${escapeHtml(typed)}">
<button id="history-base-pin" class="tool">Pin</button>
<span id="history-base-current" class="base-current">${describeBase(view)}</span>
</span>`;
}

/** Pinned label + hash, or what Automatic resolved to for the current comparison. */
function describeBase(view: HistoryView): string {
  const base = view.state.base;
  if (base.kind === "pinned") {
    const subject = view.commits.get(base.oid)?.subject;
    const suffix = subject === undefined ? "" : ` <span class="subject">${escapeHtml(subject)}</span>`;
    return `<span class="base-pinned">${escapeHtml(base.label)}</span> <code>${shortHash(base.oid)}</code>${suffix}`;
  }

  const comparison = view.state.comparison;
  const isResolved = comparison !== null && comparison.kind !== "needsBase";
  if (!isResolved) {
    return "Automatic";
  }
  const resolved = comparison.base;
  const label = escapeHtml(describeResolvedBase(resolved));
  return resolved.kind === "commit"
    ? `Automatic: <code>${label}</code> <span class="subject">${escapeHtml(resolved.subject)}</span>`
    : `Automatic: ${label}`;
}

function renderSelectionSummary(view: HistoryView): string {
  const count = view.state.selectedOids.length;
  const hidden = view.context.hiddenSelectedCount;
  const hiddenText = hidden > 0
    ? ` <span id="history-hidden-selected" class="hidden-selected">${hidden} hidden by filters</span>`
    : "";
  return `<span class="toolbar-group selection-summary">
<span id="history-selection-count" aria-live="polite">${count} selected${hiddenText}</span>
<button id="history-clear-selection" class="tool"${count === 0 ? " disabled" : ""}>Clear</button>
</span>`;
}

// ----------------------------------------------------------------- status

function renderStatus(view: HistoryView): string {
  const status = describeStatus(view);
  return `<div id="history-status" class="history-status status-${status.tone}" role="status" aria-live="polite">${status.text}</div>`;
}

/** One line covering the most relevant of the controller's states; text is already escaped. */
function describeStatus(view: HistoryView): StatusLine {
  const { operations, error, history, selectedOids, comparison } = view.state;
  if (operations.isLoading) {
    return { text: "Loading history…", tone: "busy" };
  }
  if (operations.isResolvingBase) {
    return { text: "Resolving base…", tone: "busy" };
  }
  if (operations.isComparing) {
    return { text: `Comparing ${plural(selectedOids.length, "selected commit")}…`, tone: "busy" };
  }
  if (error !== null) {
    return { text: `Could not ${FAILED_OPERATION_LABELS[error.operation]}: ${escapeHtml(error.message)}`, tone: "error" };
  }
  if (history === null) {
    return { text: "History is not loaded", tone: "info" };
  }
  if (history.commits.length === 0) {
    return { text: "This repository has no commits", tone: "info" };
  }
  if (selectedOids.length === 0) {
    return { text: "Select commits to see their changes", tone: "info" };
  }
  return describeComparison(view, comparison);
}

function describeComparison(view: HistoryView, comparison: ComparisonResult | null): StatusLine {
  if (comparison === null) {
    return { text: "Comparison pending", tone: "busy" };
  }
  switch (comparison.kind) {
    case "needsBase": {
      const minima = comparison.minimumOids.map((oid) => `<code>${shortHash(oid)}</code>`).join(", ");
      return { text: `The selection has several earliest commits (${minima}); pin a base to compare`, tone: "warning" };
    }
    case "blocked":
      return { text: `Replay stopped at ${commitLabel(view, comparison.failingOid)}: ${escapeHtml(comparison.explanation)}`, tone: "error" };
    case "ready":
      return comparison.files.length === 0
        ? { text: "The selected changes cancel out: no net file changes", tone: "info" }
        : { text: `${plural(comparison.files.length, "file")} changed`, tone: "info" };
  }
}

// ---------------------------------------------------------- commit table

function renderCommitPane(view: HistoryView, rows: readonly VisibleGraphRow[], visibleCount: number): string {
  const graphLanes = Math.max(1, ...rows.map((entry) => entry.row.width));
  const focusedOid = rows.some((entry) => entry.row.oid === view.context.presentation.focusedOid)
    ? view.context.presentation.focusedOid
    : rows[0]?.row.oid ?? null;
  const body = rows.map((entry) => renderCommitRow(view, entry, graphLanes, entry.row.oid === focusedOid)).join("\n");
  const remaining = visibleCount - rows.length;
  const loadMore = remaining > 0
    ? `<button id="history-load-more" class="load-more" data-row-limit="${rows.length + HISTORY_PAGE_SIZE}">Load more (${remaining} more)</button>`
    : "";

  return `<section class="commit-pane" aria-label="Commits">
<table id="history-commits" class="commit-table" role="grid" aria-label="Commits" aria-multiselectable="true" aria-rowcount="${visibleCount + 1}">
<thead><tr role="row"><th class="graph-cell" scope="col"><span class="sr-only">Graph</span></th><th scope="col">Subject</th><th scope="col">Author</th><th scope="col">Date</th><th scope="col">Hash</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
${rows.length === 0 ? `<p class="empty">No commits match the filters</p>` : ""}
${loadMore}
</section>`;
}

/** `hasTabStop` marks the one row Tab reaches; `is-focused` marks the user's focused row. */
function renderCommitRow(view: HistoryView, entry: VisibleGraphRow, graphLanes: number, hasTabStop: boolean): string {
  const commit = view.commits.get(entry.row.oid)!;
  const isSelected = view.selected.has(commit.oid);
  const isFocused = commit.oid === view.context.presentation.focusedOid;
  const classes = ["commit-row", isSelected ? "is-selected" : "", isFocused ? "is-focused" : ""].filter(Boolean).join(" ");
  const current = isFocused ? ` aria-current="true"` : "";

  return `<tr class="${classes}" role="row" data-oid="${escapeHtml(commit.oid)}" aria-selected="${isSelected}" tabindex="${hasTabStop ? 0 : -1}"${current}>`
    + `<td class="graph-cell" role="gridcell">${renderGraph(entry, graphLanes, commit.parents.length > 1)}</td>`
    + `<td class="subject-cell" role="gridcell">${renderRefLabels(view, commit.oid)}<span class="subject">${escapeHtml(commit.subject)}</span></td>`
    + `<td class="author-cell" role="gridcell">${escapeHtml(commit.author)}</td>`
    + `<td class="date-cell" role="gridcell"><time datetime="${escapeHtml(commit.authoredDate)}">${escapeHtml(formatDate(commit.authoredDate))}</time></td>`
    + `<td class="hash-cell" role="gridcell"><code>${shortHash(commit.oid)}</code></td>`
    + `</tr>`;
}

function renderRefLabels(view: HistoryView, oid: string): string {
  return (view.refs.get(oid) ?? [])
    .map((ref) => `<span class="ref-label ${REF_CLASSES[ref.kind]}">${escapeHtml(ref.name)}</span>`)
    .join("");
}

// ------------------------------------------------------------------ graph

/** Decorative SVG; dashed `graph-gap` lines mark rows hidden by filters instead of joining across them. */
function renderGraph(entry: VisibleGraphRow, lanes: number, isMerge: boolean): string {
  const { row } = entry;
  const width = lanes * LANE_WIDTH;
  const middle = ROW_HEIGHT / 2;
  const upper = row.upper.map((segment) => renderSegment(segment, 0, middle, entry.hasHiddenAbove));
  const lower = row.lower.map((segment) => renderSegment(segment, middle, ROW_HEIGHT, entry.hasHiddenBelow));
  const nodeClass = `graph-node ${laneClass(row.color)}${isMerge ? " is-merge" : ""}`;
  const node = `<circle class="${nodeClass}" cx="${laneX(row.lane)}" cy="${middle}" r="${NODE_RADIUS}"/>`;

  return `<svg class="graph" width="${width}" height="${ROW_HEIGHT}" viewBox="0 0 ${width} ${ROW_HEIGHT}" aria-hidden="true" focusable="false">${upper.join("")}${lower.join("")}${node}</svg>`;
}

function renderSegment(segment: GraphSegment, y1: number, y2: number, isGap: boolean): string {
  const classes = `graph-edge ${laneClass(segment.color)}${isGap ? " graph-gap" : ""}`;
  return `<line class="${classes}" x1="${laneX(segment.from)}" y1="${y1}" x2="${laneX(segment.to)}" y2="${y2}"/>`;
}

function laneX(lane: number): number {
  return requireLaneNumber(lane) * LANE_WIDTH + LANE_WIDTH / 2;
}

function laneClass(color: number): string {
  return `lane-${requireLaneNumber(color) % LANE_COLOR_COUNT}`;
}

/** Only small non-negative integers ever reach SVG attributes. */
function requireLaneNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid graph coordinate: ${value}`);
  }
  return value;
}

// ------------------------------------------------------------ side panes

function renderFiles(view: HistoryView): string {
  const comparison = view.state.comparison;
  return `<section id="history-files" class="files-pane" aria-labelledby="history-files-heading">
<h2 id="history-files-heading">Changed files</h2>
${comparison?.kind === "ready" ? renderFileList(comparison.snapshotId, comparison.files) : ""}
${comparison?.kind === "blocked" ? renderBlockedPaths(comparison.paths) : ""}
</section>`;
}

function renderFileList(snapshotId: string, files: readonly ComparisonFile[]): string {
  if (files.length === 0) {
    return `<p class="empty">No net changes</p>`;
  }
  const items = files.map((file) => `<li>${renderFileButton(snapshotId, file)}</li>`).join("\n");
  return `<ul id="history-file-list" class="file-list" aria-label="Changed files; press Enter or double-click to open a diff">\n${items}\n</ul>`;
}

function renderFileButton(snapshotId: string, file: ComparisonFile): string {
  const status = FILE_STATUS_LABELS[file.status];
  const path = file.result?.path ?? file.base?.path ?? "";
  const oldPath = file.base?.path ?? "";
  const isRenamed = file.status === "renamed";
  const details = describeFileDetails(file);
  const origin = isRenamed ? ` <span class="file-origin">← ${escapeHtml(oldPath)}</span>` : "";
  const meta = details.length > 0 ? ` <span class="file-meta">${escapeHtml(details.join("; "))}</span>` : "";
  const label = isRenamed ? `${status.name}: ${oldPath} → ${path}` : `${status.name}: ${path}`;
  const title = [path, ...details].join("\n");

  return `<button class="file-row status-${file.status}" data-snapshot-id="${escapeHtml(snapshotId)}" data-file-id="${escapeHtml(file.id)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(title)}">`
    + `<span class="file-status" aria-hidden="true">${status.letter}</span> <span class="file-path">${escapeHtml(path)}</span>${origin}${meta}</button>`;
}

/** Metadata that the diff editor will not show as text: binary, submodule and mode-only changes. */
function describeFileDetails(file: ComparisonFile): readonly string[] {
  const details: string[] = [];
  if (file.contentKind === "binary") {
    details.push("Binary file");
  }
  if (file.contentKind === "gitlink") {
    details.push(`Submodule ${file.base?.blob ?? "none"} → ${file.result?.blob ?? "none"}`);
  }
  const oldMode = file.base?.mode;
  const newMode = file.result?.mode;
  const isModeChanged = oldMode !== undefined && newMode !== undefined && oldMode !== newMode;
  if (isModeChanged) {
    details.push(`Mode ${oldMode} → ${newMode}`);
  }
  return details;
}

function renderBlockedPaths(paths: readonly string[]): string {
  const items = paths.map((path) => `<li>${escapeHtml(path)}</li>`).join("");
  return `<p class="blocked-note">No files can be opened until the replay applies cleanly. Conflicting paths:</p>
<ul class="blocked-paths">${items}</ul>`;
}

/** Selected commits in replay order (selection order until Git has ordered them), with merge-parent pickers. */
function renderReplay(view: HistoryView): string {
  const comparison = view.state.comparison;
  const hasOrder = comparison !== null && comparison.kind !== "needsBase";
  const oids = hasOrder ? comparison.orderedOids : view.state.selectedOids;
  const failingOid = comparison?.kind === "blocked" ? comparison.failingOid : null;
  const items = oids.map((oid) => {
    const failing = oid === failingOid ? ` class="is-failing"` : "";
    return `<li data-oid="${escapeHtml(oid)}"${failing}>${commitLabel(view, oid)}${renderMainlineSelect(view, oid)}</li>`;
  });
  const heading = hasOrder ? "Replay order" : "Selected commits";

  return `<section id="history-replay" class="replay-pane" aria-labelledby="history-replay-heading">
<h2 id="history-replay-heading">${heading}</h2>
${items.length > 0 ? `<ol class="replay-order">${items.join("")}</ol>` : ""}
</section>`;
}

function renderMainlineSelect(view: HistoryView, oid: string): string {
  const commit = view.commits.get(oid);
  if (!commit || commit.parents.length < 2) {
    return "";
  }
  const chosen = view.state.mainlines.find((choice) => choice.oid === oid)?.parentNumber ?? 1;
  const options = commit.parents.map((parent, index) => {
    const subject = view.commits.get(parent)?.subject ?? "";
    return option(String(index + 1), `Parent ${index + 1}: ${shortHash(parent)} ${subject}`.trimEnd(), index + 1 === chosen);
  });
  return ` <select class="mainline-select" data-oid="${escapeHtml(commit.oid)}" aria-label="Compare merge ${shortHash(commit.oid)} against parent">${options.join("")}</select>`;
}

function renderDetails(view: HistoryView): string {
  const focusedOid = view.context.presentation.focusedOid;
  const commit = focusedOid === null ? undefined : view.commits.get(focusedOid);
  const body = commit ? renderCommitDetails(view, commit) : `<p class="empty">Focus a commit to see its details</p>`;
  return `<section id="history-details" class="details-pane" aria-labelledby="history-details-heading">
<h2 id="history-details-heading">Commit details</h2>
${body}
</section>`;
}

function renderCommitDetails(view: HistoryView, commit: HistoryCommit): string {
  const parents = commit.parents.map((parent) => `<code>${shortHash(parent)}</code>`).join(" ") || "none (root commit)";
  return `<p class="details-subject">${escapeHtml(commit.subject)}</p>
<p class="details-refs">${renderRefLabels(view, commit.oid)}</p>
<dl class="details-fields">
<dt>Hash</dt><dd><code>${escapeHtml(commit.oid)}</code></dd>
<dt>Author</dt><dd>${escapeHtml(commit.author)}</dd>
<dt>Date</dt><dd><time datetime="${escapeHtml(commit.authoredDate)}">${escapeHtml(formatDate(commit.authoredDate))}</time></dd>
<dt>Parents</dt><dd>${parents}</dd>
</dl>`;
}

// ---------------------------------------------------------------- helpers

function option(value: string, label: string, isSelected: boolean): string {
  return `<option value="${escapeHtml(value)}"${isSelected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

/** Short hash plus subject when the commit is loaded; escaped. */
function commitLabel(view: HistoryView, oid: string): string {
  const subject = view.commits.get(oid)?.subject;
  const suffix = subject === undefined ? "" : ` <span class="subject">${escapeHtml(subject)}</span>`;
  return `<code>${shortHash(oid)}</code>${suffix}`;
}

/** Escaped short hash for markup. */
function shortHash(oid: string): string {
  return escapeHtml(abbreviate(oid));
}

/** `YYYY-MM-DD HH:MM` in the author's own time zone; unexpected formats are shown as given. */
function formatDate(isoDate: string): string {
  const match = ISO_MINUTE_PATTERN.exec(isoDate);
  return match ? `${match[1]} ${match[2]}` : isoDate;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
