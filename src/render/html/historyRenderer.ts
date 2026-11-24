import { branchFilterRef, CHECKED_OUT_BRANCH } from "../../model/historyBranchFilter";
import type { BranchFilter } from "../../model/historyBranchFilter";
import { HistoryGraphLayout, visibleGraphRows } from "../../model/historyGraph";
import type { GraphSegment, HistoryGraphRow, VisibleGraphRow } from "../../model/historyGraph";
import { describeResolvedBase, shortHash as abbreviate } from "../../model/historyLabels";
import type {
  ComparisonFile,
  ComparisonResult,
  FileStatus,
  HistoryCommit,
  HistoryData,
  HistoryHead,
  HistoryOperation,
  HistoryRef,
  HistoryRefKind,
  HistoryState,
  OpenedFile,
} from "../../model/historyTypes";
import {
  describeSelectedChanges,
  isWorkingChangeId,
  presentWorkingChangeIds,
  STAGED_CHANGES_ID,
  WORKING_CHANGE_PATH_LIMIT,
  workingChangeCount,
  workingChangeLabel,
} from "../../model/historyWorkingChanges";
import type { WorkingChangeId, WorkingChangeSummary } from "../../model/historyWorkingChanges";
import { escapeHtml, type WebviewAssets } from "./webviewMarkup";

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
  /** The branch filter option picked: `CHECKED_OUT_BRANCH`, a filter ref, or null for all branches. */
  readonly branchChoice: string | null;
  /** Limits the list to this branch's loaded history, as resolved from `branchChoice`; null shows all branches. */
  readonly branch: BranchFilter | null;
  readonly focusedOid: string | null;
  readonly rowLimit: number;
}

/** The Select branch button: whether a click selects anything, and the tooltip saying what or why not. */
export interface SelectBranchButton {
  readonly isEnabled: boolean;
  readonly title: string;
}

/** Everything besides the domain state that one page needs; computed by the host. */
export interface HistoryPageContext {
  readonly repositories: readonly HistoryRepositoryOption[];
  readonly activeRepositoryId: string | null;
  readonly presentation: HistoryPresentation;
  /** OIDs of the state's history passing the host's search and branch filters, in graph order. */
  readonly visibleOids: readonly string[];
  /** Working-change rows with changes that pass the filters, in table order: Unstaged above Staged. */
  readonly visibleWorkingIds: readonly WorkingChangeId[];
  /** Selected commits and working changes the filters currently hide. */
  readonly hiddenSelectedCount: number;
  /** Publication counter every client intent must echo. */
  readonly wireRevision: number;
  /** The file jw-differ's diff panel shows, of whichever comparison it was opened from. */
  readonly openedFile: OpenedFile | null;
  readonly selectBranch: SelectBranchButton;
}

/** A page context plus what only a whole document needs. */
export interface HistoryRenderContext extends HistoryPageContext {
  readonly assets: WebviewAssets;
  /** `fuzzyMatch.js`, the branch filter's matcher, which `branchFilter.js` calls. */
  readonly fuzzyMatchScriptUri: string;
  /** `branchFilter.js`, the branch filter's combobox, which the client script creates. */
  readonly branchFilterScriptUri: string;
  readonly nonce: string;
}

/**
 * Published as JSON in `body[data-history]` and in every update, for the client script. The client reads the
 * rendered rows from the table itself.
 */
export interface HistoryPublicState {
  readonly revision: number;
  readonly repositoryId: string | null;
  /** Full selection, including commits hidden by filters or paging. */
  readonly selectedOids: readonly string[];
  readonly focusedOid: string | null;
  readonly search: string;
  /** The branch filter choice, as its option value; null for all branches. */
  readonly branch: string | null;
  readonly rowLimit: number;
  /** Snapshot whose files are listed; null unless the comparison is ready. */
  readonly snapshotId: string | null;
  /** Listed file the diff panel shows; the client marks it, so it never changes the rendered markup. */
  readonly openFileId: string | null;
}

/** Where a graph node sits: its lane and that lane's colour counter. */
export interface GraphAnchor {
  readonly lane: number;
  readonly color: number;
}

/**
 * The rows a page shows: the `workingIds` rows, then the first `count` of `visibleOids` in `history`, with graphs
 * `graphColumns` wide.
 */
export interface HistoryRowSet {
  readonly history: HistoryData | null;
  readonly visibleOids: readonly string[];
  readonly workingIds: readonly WorkingChangeId[];
  readonly count: number;
  readonly graphColumns: number;
  /** HEAD's node when it is the first commit row, which the working-change rows then join; null otherwise. */
  readonly workingAnchor: GraphAnchor | null;
}

/** What one page shows, so that an update can carry only the differences. */
export interface HistoryPage {
  /** Markup of each replaceable element besides the commit table, by element ID. */
  readonly regions: Readonly<Record<string, string>>;
  readonly rows: HistoryRowSet;
}

export interface HistoryDocument {
  readonly html: string;
  readonly page: HistoryPage;
}

/** Host-to-webview message that changes the shown page in place. */
export interface HistoryUpdate {
  readonly type: "update";
  readonly state: HistoryPublicState;
  /** Replacement markup (`outerHTML`) of each changed element, by ID; `history-commits` when the rows changed. */
  readonly regions: Readonly<Record<string, string>>;
  /** Rows to add at the end of the commit table; empty when there are none. */
  readonly appendedRows: string;
}

export interface HistoryPatch {
  readonly update: HistoryUpdate;
  /** The page once the update is applied. */
  readonly page: HistoryPage;
}

/**
 * Lookups over one loaded history, built once per load rather than per render. The layout indexes
 * `history.commits`, so `layout.indexOf` also finds commits by OID.
 */
interface HistoryIndex {
  readonly history: HistoryData;
  readonly layout: HistoryGraphLayout;
  readonly refs: ReadonlyMap<string, readonly HistoryRef[]>;
}

/** Lookups shared by the markup functions of one render. */
interface HistoryView {
  readonly state: HistoryState;
  readonly context: HistoryPageContext;
  readonly commitOf: (oid: string) => HistoryCommit | undefined;
  readonly refs: ReadonlyMap<string, readonly HistoryRef[]>;
  readonly selected: ReadonlySet<string>;
  /** HEAD when working-change rows are shown and HEAD is the first commit row, so a line joins them; else null. */
  readonly workingLinkOid: string | null;
}

type StatusTone = "info" | "busy" | "warning" | "error";

interface StatusLine {
  readonly text: string;
  readonly tone: StatusTone;
}

const LANE_WIDTH = 12;
const ROW_HEIGHT = 22;
const NODE_RADIUS = 3.5;
/** Lanes drawn apart. Later lanes share one overflow column, so a very branchy history keeps a usable width. */
const DRAWN_LANE_COUNT = 16;
const OVERFLOW_COLUMN = DRAWN_LANE_COUNT;
/** Lines into the overflow column end at its left edge. */
const OVERFLOW_EDGE_X = OVERFLOW_COLUMN * LANE_WIDTH;
const OVERFLOW_TITLE = `The graph is too wide to draw every line: lanes after the first ${DRAWN_LANE_COUNT} share the last column`;
/** Cut stubs stop short of the row's bottom edge, so they never read as a line continuing into the next row. */
const CUT_STUB_END_Y = ROW_HEIGHT - 2;
/** How far right of its node the most angled cut stub ends; stubs stay within the node's column. */
const CUT_STUB_SPREAD = LANE_WIDTH / 2 - 1;
const LANE_COLOR_COUNT = 8;
const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/;
const COMMIT_TABLE_ID = "history-commits";
const WORKING_ROWS_ID = "history-working-rows";
const WORKING_NODE_TITLE = "Uncommitted changes on top of HEAD";
const NOT_A_COMMIT_TITLE = "Not a commit";
const NO_HASH = "—";
/** Working-change rows stand on HEAD's lane, or on the first lane when HEAD is not the first commit row. */
const FIRST_LANE_ANCHOR: GraphAnchor = { lane: 0, color: 0 };
const ISO_MINUTE_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;
const ISO_SECOND_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?/;
/** How rows are selected; the selection count and the subject column explain it on hover. */
const SELECTION_GESTURES = "Click selects one commit; Ctrl/Cmd+click adds or removes one; Shift+click selects the range from the last commit clicked without Shift, Ctrl/Cmd+Shift+click adds that range; ↑/↓ move, Shift+↑/↓ extend, Space toggles";
const SEARCH_TITLE = "Search commits by subject or hash (literal, ignores case); filtering never changes the selection";
/** The client names the chosen branch in its tooltip once it runs. */
const BRANCH_INPUT_TITLE = "Branch filter: click or type to choose a branch";
const BASE_LABEL_TITLE = "Comparison base: the commit the selected changes are replayed onto and compared against";
const BASE_INPUT_TITLE = "Commit, branch or tag to pin as the base; press Enter or Pin";
const PIN_TITLE = "Pin the base to the commit, branch or tag typed in the box (Enter)";
/** A branch line leaving a main line, as in a branch graph. */
const SELECT_BRANCH_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="4.5" r="1.5"/><path d="M4.5 5v6M11.5 6c0 3.5-7 2-7 5"/></g></svg>`;
/** A funnel drawn like VS Code's filter codicon, in the toggle's text colour. */
const FILTER_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>`;

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

const COLUMN_HEADERS = [
  `<th class="graph-cell" scope="col" title="Commit graph: lines join each commit to its parents; dashed lines pass commits the filters hide"><span class="sr-only">Graph</span></th>`,
  `<th scope="col" title="Commit subject, after its branch and tag labels. ${SELECTION_GESTURES}">Subject</th>`,
  `<th scope="col" title="Commit author">Author</th>`,
  `<th scope="col" title="Author date, in the author's time zone">Date</th>`,
  `<th scope="col" title="Abbreviated commit hash">Hash</th>`,
].join("");

const REF_KIND_LABELS: Readonly<Record<HistoryRefKind, string>> = {
  head: "Detached HEAD",
  localBranch: "Local branch",
  remoteBranch: "Remote branch",
  tag: "Tag",
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
 * The document is rendered once; `update` then patches it in place by
 * element ID (see `HistoryUpdate`), sending rows only when they change.
 *
 * Client contract: controls `#history-repository` (select, root IDs),
 * `#history-choose-repository`, `#history-refresh`, `#history-search`,
 * `#history-branch` (select, `CHECKED_OUT_BRANCH`, branch ref or `""` = all), `#history-branch-local-only`,
 * `#history-select-branch`,
 * `#history-base-automatic`, `#history-base-input` + `#history-base-pin`, `#history-clear-selection`,
 * `#history-load-more[data-row-limit]`; rows `#history-commits tr.commit-row[data-oid]`;
 * `select.mainline-select[data-oid]` (value = one-based parent);
 * file buttons `button.file-row[data-snapshot-id][data-file-id]`.
 */
export class HtmlHistoryRenderer {
  private index: HistoryIndex | null = null;
  /** One option per branch, which on large repositories makes it the largest region by far. */
  private branchFilter: { readonly history: HistoryData | null; readonly branch: string | null; readonly markup: string } | null = null;

  render(state: HistoryState, context: HistoryRenderContext): HistoryDocument {
    if (!NONCE_PATTERN.test(context.nonce)) {
      throw new Error("History renderer needs a base64-style nonce of at least 16 characters");
    }
    const view = this.viewOf(state, context);
    const entries = this.rowsOf(view);
    const rows = rowSetOf(view, entries);
    const regions = renderRegions(view, rows, this.branchFilterOf(view));
    const { assets, nonce } = context;
    const csp = [
      "default-src 'none'",
      `style-src ${assets.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<link href="${escapeHtml(assets.styleUri)}" rel="stylesheet">
<title>Git History</title>
</head>
<body data-history="${escapeHtml(JSON.stringify(createPublicState(state, context)))}">
${renderToolbar(view.context.presentation, regions)}
${regions["history-status"]}
<main class="history-layout">
<section class="commit-pane" aria-label="Commits">
${renderCommitTable(view, entries, rows, regions[WORKING_ROWS_ID])}
${regions["history-commit-footer"]}
</section>
<aside class="detail-pane">
${regions["history-files"]}
${regions["history-replay"]}
${regions["history-details"]}
</aside>
</main>
<script nonce="${nonce}" src="${escapeHtml(context.fuzzyMatchScriptUri)}"></script>
<script nonce="${nonce}" src="${escapeHtml(context.branchFilterScriptUri)}"></script>
<script nonce="${nonce}" src="${escapeHtml(assets.scriptUri)}"></script>
</body>
</html>`;
    return { html, page: { regions, rows } };
  }

  /**
   * Changes `shown` into the page for `state`: regions whose markup changed, plus the rows only when the history,
   * filters or row limit changed. A larger limit over the same rows appends the new rows, unless they widen the graph.
   */
  update(state: HistoryState, context: HistoryPageContext, shown: HistoryPage): HistoryPatch {
    const view = this.viewOf(state, context);
    const count = state.history ? Math.min(rowLimit(context), context.visibleOids.length) : 0;
    const isSameFilter = state.history === shown.rows.history && context.visibleOids === shown.rows.visibleOids
      && isSameList(context.visibleWorkingIds, shown.rows.workingIds);
    const entries = isSameFilter && count === shown.rows.count ? null : this.rowsOf(view);
    const rows = entries === null ? shown.rows : rowSetOf(view, entries);
    const regions = renderRegions(view, rows, this.branchFilterOf(view));
    const changed: Record<string, string> = {};
    let appendedRows = "";
    if (entries !== null) {
      const isAppend = isSameFilter && rows.count > shown.rows.count && rows.graphColumns === shown.rows.graphColumns;
      if (isAppend) {
        appendedRows = entries.slice(shown.rows.count).map((entry) => renderCommitRow(view, entry, rows.graphColumns, false)).join("\n");
      } else {
        changed[COMMIT_TABLE_ID] = renderCommitTable(view, entries, rows, regions[WORKING_ROWS_ID]);
      }
    }
    // A replaced table already holds the working-change rows.
    const isTableReplaced = COMMIT_TABLE_ID in changed;
    for (const [id, markup] of Object.entries(regions)) {
      const isInReplacedTable = isTableReplaced && id === WORKING_ROWS_ID;
      if (shown.regions[id] !== markup && !isInReplacedTable) {
        changed[id] = markup;
      }
    }
    const update: HistoryUpdate = { type: "update", state: createPublicState(state, context), regions: changed, appendedRows };
    return { update, page: { regions, rows } };
  }

  private viewOf(state: HistoryState, context: HistoryPageContext): HistoryView {
    return createView(state, context, this.indexFor(state.history));
  }

  private branchFilterOf(view: HistoryView): string {
    const { history } = view.state;
    const branch = view.context.presentation.branchChoice;
    const cached = this.branchFilter;
    if (cached?.history === history && cached.branch === branch) {
      return cached.markup;
    }
    const markup = renderBranchFilter(view);
    this.branchFilter = { history, branch, markup };
    return markup;
  }

  private rowsOf(view: HistoryView): readonly VisibleGraphRow[] {
    const index = this.index;
    return index && view.state.history ? visibleGraphRows(index.layout, view.context.visibleOids, rowLimit(view.context)) : [];
  }

  /** Reused until metadata is reloaded, so the graph layout keeps the rows it has laid out. */
  private indexFor(history: HistoryData | null): HistoryIndex | null {
    if (history !== (this.index?.history ?? null)) {
      this.index = history ? indexHistory(history) : null;
    }
    return this.index;
  }
}

function indexHistory(history: HistoryData): HistoryIndex {
  const refs = new Map<string, HistoryRef[]>();
  for (const ref of history.refs) {
    refs.set(ref.oid, [...(refs.get(ref.oid) ?? []), ref]);
  }
  return { history, layout: new HistoryGraphLayout(history.commits), refs };
}

function createView(state: HistoryState, context: HistoryPageContext, index: HistoryIndex | null): HistoryView {
  const commitOf = (oid: string): HistoryCommit | undefined => {
    const position = index?.layout.indexOf(oid);
    return position === undefined ? undefined : index?.history.commits[position];
  };
  const head = state.history?.head;
  const isHeadLinked = head !== undefined && head !== null && context.visibleWorkingIds.length > 0
    && context.visibleOids[0] === head.oid;
  const workingLinkOid = isHeadLinked ? head.oid : null;
  return { state, context, commitOf, refs: index?.refs ?? new Map(), selected: new Set(state.selectedOids), workingLinkOid };
}

function rowLimit(context: HistoryPageContext): number {
  const limit = context.presentation.rowLimit;
  return Number.isInteger(limit) && limit > 0 ? limit : HISTORY_PAGE_SIZE;
}

function createPublicState(state: HistoryState, context: HistoryPageContext): HistoryPublicState {
  const { presentation, openedFile } = context;
  const snapshotId = state.comparison?.kind === "ready" ? state.comparison.snapshotId : null;
  return {
    revision: context.wireRevision,
    repositoryId: context.activeRepositoryId,
    selectedOids: state.selectedOids,
    focusedOid: presentation.focusedOid,
    search: presentation.search,
    branch: presentation.branchChoice,
    rowLimit: rowLimit(context),
    snapshotId,
    openFileId: openedFile !== null && openedFile.snapshotId === snapshotId ? openedFile.fileId : null,
  };
}

function rowSetOf(view: HistoryView, entries: readonly VisibleGraphRow[]): HistoryRowSet {
  const { history } = view.state;
  const { visibleOids, visibleWorkingIds } = view.context;
  const first = entries[0]?.row;
  const workingAnchor = first !== undefined && first.oid === view.workingLinkOid ? { lane: first.lane, color: first.color } : null;
  return {
    history,
    visibleOids,
    workingIds: visibleWorkingIds,
    count: entries.length,
    graphColumns: graphColumnsOf(entries),
    workingAnchor,
  };
}

function isSameList(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

/** Every element an update may replace, by ID, except the commit table. */
type RegionId =
  | typeof WORKING_ROWS_ID
  | "history-repository"
  | "history-branch"
  | "history-select-branch"
  | "history-base-automatic"
  | "history-base-input"
  | "history-base-current"
  | "history-selection"
  | "history-status"
  | "history-commit-footer"
  | "history-files"
  | "history-replay"
  | "history-details";

type Regions = Readonly<Record<RegionId, string>>;

function renderRegions(view: HistoryView, rows: HistoryRowSet, branchFilter: string): Regions {
  return {
    "history-repository": renderRepositorySelect(view.context),
    "history-branch": branchFilter,
    "history-select-branch": renderSelectBranch(view.context.selectBranch),
    ...renderBaseControls(view),
    "history-selection": renderSelectionSummary(view),
    "history-status": renderStatus(view),
    "history-commit-footer": renderCommitFooter(view, rows.count),
    [WORKING_ROWS_ID]: renderWorkingRows(view, rows),
    "history-files": renderFiles(view),
    "history-replay": renderReplay(view),
    "history-details": renderDetails(view),
  };
}

// ---------------------------------------------------------------- toolbar

/**
 * The search box and the branch filter's combobox are never replaced, so text typed and a list opened while an
 * update arrives stay. The combobox picks from the hidden `#history-branch` select, the region the host renders; its
 * local-only toggle, pressed by the client from its saved view, is never replaced either.
 */
function renderToolbar(presentation: HistoryPresentation, regions: Regions): string {
  return `<header class="history-toolbar" role="toolbar" aria-label="History controls">
<span class="toolbar-group">${regions["history-repository"]}<button id="history-choose-repository" class="tool" title="Open another repository folder">Open…</button><button id="history-refresh" class="tool" title="Reload history" aria-label="Refresh history">⟳</button></span>
<input id="history-search" class="search" type="search" placeholder="Search subject or hash" aria-label="Search commits by subject or hash" title="${SEARCH_TITLE}" value="${escapeHtml(presentation.search)}">
<span class="toolbar-group"><span class="branch-filter"><input id="history-branch-input" class="branch-input" type="text" role="combobox" aria-label="Branch filter" title="${BRANCH_INPUT_TITLE}" aria-autocomplete="list" aria-expanded="false" aria-controls="history-branch-list" autocomplete="off" spellcheck="false"><ul id="history-branch-list" class="branch-list" role="listbox" aria-label="Branches" hidden></ul>${regions["history-branch"]}</span><button id="history-branch-local-only" class="option-toggle" title="Show local branches only" aria-label="Show local branches only" aria-pressed="false">${FILTER_ICON}</button>${regions["history-select-branch"]}</span>
<span class="toolbar-group base-control" role="group" aria-label="Comparison base">
<span class="label" title="${BASE_LABEL_TITLE}">Base:</span>
${regions["history-base-automatic"]}
${regions["history-base-input"]}
<button id="history-base-pin" class="tool" title="${PIN_TITLE}">Pin</button>
${regions["history-base-current"]}
</span>
${regions["history-selection"]}
</header>`;
}

function renderSelectBranch(button: SelectBranchButton): string {
  const title = escapeHtml(button.title);
  const disabled = button.isEnabled ? "" : " disabled";
  return `<button id="history-select-branch" class="icon-button" title="${title}" aria-label="Select branch commits"${disabled}>${SELECT_BRANCH_ICON}</button>`;
}

function renderRepositorySelect(context: HistoryPageContext): string {
  const options = context.repositories
    .map((repository) => option(repository.id, repository.name, repository.id === context.activeRepositoryId))
    .join("");
  const active = context.repositories.find((repository) => repository.id === context.activeRepositoryId);
  const title = active === undefined ? "Repository whose history is shown" : `Repository whose history is shown: ${active.name}`;
  return context.repositories.length === 0
    ? `<select id="history-repository" aria-label="Repository" title="No Git repository is open; use Open… to choose a folder" disabled><option value="">No repository</option></select>`
    : `<select id="history-repository" aria-label="Repository" title="${escapeHtml(title)}">${options}</select>`;
}

function renderBranchFilter(view: HistoryView): string {
  const selected = view.context.presentation.branchChoice;
  // A truncated history may not reach a stale branch's tip, and filtering by it would show nothing. Refs are unique,
  // so of several branches sharing a tip only the chosen one is marked.
  const options = (view.state.history?.refs ?? []).flatMap((ref) => {
    const value = branchFilterRef(ref);
    return value !== null && view.commitOf(ref.oid) !== undefined ? [branchOption(value, ref, value === selected)] : [];
  });
  const fixedOptions = option("", "All branches", selected === null)
    + option(CHECKED_OUT_BRANCH, checkedOutLabel(view.state.history?.head ?? null), selected === CHECKED_OUT_BRANCH);
  return `<select id="history-branch" hidden>${fixedOptions}${options.join("")}</select>`;
}

/** A branch filter option for `ref`, with its kind for the client. */
function branchOption(value: string, ref: HistoryRef, isSelected: boolean): string {
  return `<option value="${escapeHtml(value)}" data-kind="${ref.kind}"${isSelected ? " selected" : ""}>${escapeHtml(ref.name)}</option>`;
}

/** Names the branch the checked-out option shows, or says HEAD is detached; just the option's name until known. */
function checkedOutLabel(head: HistoryHead | null): string {
  if (head === null) {
    return "Checked out branch";
  }
  return head.branch === null ? "Checked out (detached HEAD)" : `Checked out branch (${head.branch})`;
}

function renderBaseControls(view: HistoryView): Pick<Regions, "history-base-automatic" | "history-base-input" | "history-base-current"> {
  const base = view.state.base;
  const isAutomatic = base.kind === "automatic";
  const typed = isAutomatic ? "" : base.label;
  const automaticTitle = isAutomatic
    ? "The base is chosen automatically: the parent of the earliest selected commit"
    : "Unpin the base and choose it automatically: the parent of the earliest selected commit";
  return {
    "history-base-automatic": `<button id="history-base-automatic" class="tool" title="${automaticTitle}" aria-pressed="${isAutomatic}">Automatic</button>`,
    "history-base-input": `<input id="history-base-input" type="text" placeholder="Commit, branch or tag" aria-label="Pin base to a commit, branch or tag" title="${BASE_INPUT_TITLE}" value="${escapeHtml(typed)}">`,
    "history-base-current": `<span id="history-base-current" class="base-current" title="${escapeHtml(describeBaseInFull(view))}">${describeBase(view)}</span>`,
  };
}

/** Plain text of the base the toolbar shows, with the full hash and subject that it may cut short. */
function describeBaseInFull(view: HistoryView): string {
  const base = view.state.base;
  if (base.kind === "pinned") {
    const subject = view.commitOf(base.oid)?.subject;
    const pinned = `Pinned base: ${base.label} ${base.oid}`;
    return subject === undefined ? pinned : `${pinned} ${subject}`;
  }
  const comparison = view.state.comparison;
  if (comparison === null) {
    return "Automatic base: the parent of the earliest selected commit, shown once the comparison is ready";
  }
  if (comparison.kind === "needsBase") {
    return "Automatic base: none, as the selection has several earliest commits; pin a base";
  }
  const resolved = comparison.base;
  switch (resolved.kind) {
    case "commit":
      return `Automatic base: ${resolved.oid} ${resolved.subject}`;
    case "emptyTree":
      return view.state.selectedOids.some((oid) => !isWorkingChangeId(oid))
        ? "Automatic base: the empty tree, as the earliest selected commit is a root commit"
        : "Automatic base: the empty tree, as HEAD has no commit yet";
    case "index":
      return "Automatic base: the staged content; the comparison starts from the index";
  }
}

/** Pinned label + hash, or what Automatic resolved to for the current comparison. */
function describeBase(view: HistoryView): string {
  const base = view.state.base;
  if (base.kind === "pinned") {
    const subject = view.commitOf(base.oid)?.subject;
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
  const hiddenTitle = `${plural(hidden, "selected commit")} hidden by the search or branch filter; they stay selected and compared`;
  const hiddenText = hidden > 0
    ? ` <span id="history-hidden-selected" class="hidden-selected" title="${hiddenTitle}">${hidden} hidden by filters</span>`
    : "";
  const clear = count === 0
    ? `<button id="history-clear-selection" class="tool" title="Nothing to clear: no commits are selected" disabled>Clear</button>`
    : `<button id="history-clear-selection" class="tool" title="Deselect every commit">Clear</button>`;
  return `<span id="history-selection" class="toolbar-group selection-summary">
<span id="history-selection-count" aria-live="polite" title="${plural(count, "commit")} selected. ${SELECTION_GESTURES}">${count} selected${hiddenText}</span>
${clear}
</span>`;
}

// ----------------------------------------------------------------- status

function renderStatus(view: HistoryView): string {
  const status = describeStatus(view);
  return `<div id="history-status" class="history-status status-${status.tone}" role="status" aria-live="polite" title="${escapeHtml(textOf(status.text))}">${status.text}</div>`;
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
    return { text: `Comparing ${describeSelectedChanges(selectedOids)}…`, tone: "busy" };
  }
  if (error !== null) {
    return { text: `Could not ${FAILED_OPERATION_LABELS[error.operation]}: ${escapeHtml(error.message)}`, tone: "error" };
  }
  if (history === null) {
    return { text: "History is not loaded", tone: "info" };
  }
  const hasWorkingChanges = presentWorkingChangeIds(view.state.workingChanges).length > 0;
  if (history.commits.length === 0 && !hasWorkingChanges) {
    return { text: "This repository has no commits", tone: "info" };
  }
  if (selectedOids.length === 0) {
    const text = history.isTruncated
      ? `${describeLoadedCount(history)}; select commits to see their changes`
      : "Select commits to see their changes";
    return { text, tone: "info" };
  }
  return describeComparison(view, comparison);
}

function describeComparison(view: HistoryView, comparison: ComparisonResult | null): StatusLine {
  if (comparison === null) {
    return { text: "Comparison pending", tone: "busy" };
  }
  switch (comparison.kind) {
    case "needsBase": {
      const minima = comparison.minimumOids
        .map((oid) => isWorkingChangeId(oid) ? workingChangeLabel(oid) : `<code>${shortHash(oid)}</code>`)
        .join(", ");
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

/** Every graph in the table is as wide as its widest row, up to the overflow column. */
function graphColumnsOf(rows: readonly VisibleGraphRow[]): number {
  return Math.min(OVERFLOW_COLUMN + 1, Math.max(1, ...rows.map((entry) => entry.row.width)));
}

/** `workingRows` is the working-change rows' region, which precedes the commit rows. */
function renderCommitTable(view: HistoryView, entries: readonly VisibleGraphRow[], rows: HistoryRowSet, workingRows: string): string {
  const tabStop = tabStopOid(view, rows);
  const body = entries.map((entry) => renderCommitRow(view, entry, rows.graphColumns, entry.row.oid === tabStop)).join("\n");
  const rowCount = view.context.visibleOids.length + rows.workingIds.length + 1;
  return `<table id="${COMMIT_TABLE_ID}" class="commit-table" role="grid" aria-label="Commits" aria-multiselectable="true" aria-rowcount="${rowCount}">
<thead><tr role="row">${COLUMN_HEADERS}</tr></thead>
${workingRows}
<tbody class="commit-rows">
${body}
</tbody>
</table>`;
}

/** The one row Tab reaches: the focused row when it is shown, else the first row. */
function tabStopOid(view: HistoryView, rows: HistoryRowSet): string | null {
  const commitOids = rows.visibleOids.slice(0, rows.count);
  const firstOid = rows.workingIds[0] ?? commitOids[0] ?? null;
  const focused = view.context.presentation.focusedOid;
  const isFocusShown = focused !== null && (rows.workingIds.some((id) => id === focused) || commitOids.includes(focused));
  return isFocusShown ? focused : firstOid;
}

/** What follows the rows: why there are none, Load more and the truncation note. */
function renderCommitFooter(view: HistoryView, rowCount: number): string {
  const remaining = view.context.visibleOids.length - rowCount;
  const loadMore = remaining > 0
    ? `<button id="history-load-more" class="load-more" data-row-limit="${rowCount + HISTORY_PAGE_SIZE}" title="Show the next ${plural(Math.min(remaining, HISTORY_PAGE_SIZE), "commit")}">Load more (${formatCount(remaining)} more)</button>`
    : "";
  const history = view.state.history;
  const truncatedNote = history?.isTruncated
    ? `<p id="history-truncated" class="truncated-note" title="The jwDiffer.historyMaxCommits setting caps how many commits are loaded">${describeLoadedCount(history)}. Older history is not loaded; raise the <code>jwDiffer.historyMaxCommits</code> setting to load more.</p>`
    : "";
  return `<div id="history-commit-footer">
${rowCount === 0 ? `<p class="empty" title="The search or branch filter hides every loaded commit">No commits match the filters</p>` : ""}
${loadMore}
${truncatedNote}
</div>`;
}

/** `hasTabStop` marks the one row Tab reaches; `is-focused` marks the user's focused row. */
function renderCommitRow(view: HistoryView, entry: VisibleGraphRow, graphColumns: number, hasTabStop: boolean): string {
  const commit = view.commitOf(entry.row.oid)!;
  const isSelected = view.selected.has(commit.oid);
  const isFocused = commit.oid === view.context.presentation.focusedOid;
  const classes = ["commit-row", isSelected ? "is-selected" : "", isFocused ? "is-focused" : ""].filter(Boolean).join(" ");
  const current = isFocused ? ` aria-current="true"` : "";
  const graphTitle = entry.row.width > DRAWN_LANE_COUNT ? `${describeParents(commit)}\n${OVERFLOW_TITLE}` : describeParents(commit);

  return `<tr class="${classes}" role="row" data-oid="${escapeHtml(commit.oid)}" aria-selected="${isSelected}" tabindex="${hasTabStop ? 0 : -1}"${current}>`
    + `<td class="graph-cell" role="gridcell" title="${escapeHtml(graphTitle)}">${renderGraph(entry, graphColumns, commit.parents.length > 1, commit.oid === view.workingLinkOid)}</td>`
    + `<td class="subject-cell" role="gridcell" title="${escapeHtml(commit.subject)}">${renderRefLabels(view, commit.oid)}<span class="subject">${escapeHtml(commit.subject)}</span></td>`
    + `<td class="author-cell" role="gridcell" title="${escapeHtml(commit.author)}">${escapeHtml(commit.author)}</td>`
    + `<td class="date-cell" role="gridcell" title="${escapeHtml(formatFullDate(commit.authoredDate))}">${renderDate(commit.authoredDate)}</td>`
    + `<td class="hash-cell" role="gridcell" title="${escapeHtml(commit.oid)}"><code>${shortHash(commit.oid)}</code></td>`
    + `</tr>`;
}

/** The graph cell's tooltip: what the node's lines join. */
function describeParents(commit: HistoryCommit): string {
  const parents = commit.parents.map(abbreviate).join(", ");
  switch (commit.parents.length) {
    case 0:
      return "Root commit: no parents";
    case 1:
      return `Parent: ${parents}`;
    default:
      return `Merge commit; parents: ${parents}`;
  }
}

function renderRefLabels(view: HistoryView, oid: string): string {
  return (view.refs.get(oid) ?? [])
    .map((ref) => `<span class="ref-label ${REF_CLASSES[ref.kind]}" title="${escapeHtml(describeRef(ref))}">${escapeHtml(ref.name)}</span>`)
    .join("");
}

function describeRef(ref: HistoryRef): string {
  return ref.kind === "head" ? REF_KIND_LABELS.head : `${REF_KIND_LABELS[ref.kind]}: ${ref.name}`;
}

// ---------------------------------------------------- working-change rows

/** Rows for the staged and unstaged changes, in their own body so a refresh of their counts replaces only them. */
function renderWorkingRows(view: HistoryView, rows: HistoryRowSet): string {
  const summary = view.state.workingChanges;
  const tabStop = tabStopOid(view, rows);
  const markup = summary === null
    ? []
    : rows.workingIds.map((id, position) => {
      const isLinkedBelow = position < rows.workingIds.length - 1 || rows.workingAnchor !== null;
      const graph = renderWorkingGraph(rows, position > 0, isLinkedBelow);
      return renderWorkingRow(view, { id, summary, graph }, id === tabStop);
    });
  return `<tbody id="${WORKING_ROWS_ID}" class="working-rows">${markup.join("\n")}</tbody>`;
}

interface WorkingRow {
  readonly id: WorkingChangeId;
  readonly summary: WorkingChangeSummary;
  /** The graph cell's SVG. */
  readonly graph: string;
}

/** A row like a commit's: its label and file count as the subject, no author or date, and no hash. */
function renderWorkingRow(view: HistoryView, row: WorkingRow, hasTabStop: boolean): string {
  const { id, summary } = row;
  const isSelected = view.selected.has(id);
  const isFocused = id === view.context.presentation.focusedOid;
  const classes = ["commit-row", "working-row", isSelected ? "is-selected" : "", isFocused ? "is-focused" : ""].filter(Boolean).join(" ");
  const current = isFocused ? ` aria-current="true"` : "";
  const label = workingChangeLabel(id);
  const count = fileCountText(workingChangeCount(summary, id), summary.isTruncated);
  const title = escapeHtml(describeWorkingChange(id, summary));

  return `<tr class="${classes}" role="row" data-oid="${id}" aria-selected="${isSelected}" tabindex="${hasTabStop ? 0 : -1}"${current} aria-label="${label}, ${count}" title="${title}">`
    + `<td class="graph-cell" role="gridcell" title="${WORKING_NODE_TITLE}">${row.graph}</td>`
    + `<td class="subject-cell" role="gridcell" title="${title}"><span class="subject working-label">${label}</span> <span class="working-count">${count}</span>${renderConflictMarker(id, summary)}</td>`
    + `<td class="author-cell" role="gridcell"></td>`
    + `<td class="date-cell" role="gridcell"></td>`
    + `<td class="hash-cell" role="gridcell" title="${NOT_A_COMMIT_TITLE}"><code>${NO_HASH}</code></td>`
    + `</tr>`;
}

/** Unstaged changes include unresolved conflicts, whose HEAD version stands in the index. */
function renderConflictMarker(id: WorkingChangeId, summary: WorkingChangeSummary): string {
  if (id === STAGED_CHANGES_ID || summary.conflicted === 0) {
    return "";
  }
  const text = plural(summary.conflicted, "conflict");
  return ` <span class="working-conflicts" title="${describeConflicts(summary)}">${text}</span>`;
}

/** The row's tooltip: what is compared with what, and what is left out. */
function describeWorkingChange(id: WorkingChangeId, summary: WorkingChangeSummary): string {
  const files = fileCountText(workingChangeCount(summary, id), summary.isTruncated);
  const isStaged = id === STAGED_CHANGES_ID;
  const sentences = isStaged
    ? [`Staged changes: ${files} in the index compared with HEAD. Select to include them; they replay after any selected commits.`]
    : [`Unstaged changes: ${files} on disk compared with the index, including ${formatCount(summary.untracked)} untracked. Unsaved editor text is not included.`];
  if (!isStaged && summary.conflicted > 0) {
    sentences.push(describeConflicts(summary));
  }
  if (summary.isTruncated) {
    const limit = `Only the first ${formatCount(WORKING_CHANGE_PATH_LIMIT)} paths are counted`;
    sentences.push(isStaged ? `${limit}.` : `${limit}, so a comparison of them is incomplete.`);
  }
  return sentences.join(" ");
}

function describeConflicts(summary: WorkingChangeSummary): string {
  const verb = summary.conflicted === 1 ? "uses" : "use";
  return `${plural(summary.conflicted, "conflicted file")} ${verb} the HEAD version in the index.`;
}

/** `3 files`, or `5,000+ files` when more paths changed than were counted. */
function fileCountText(count: number, isTruncated: boolean): string {
  const suffix = isTruncated ? "+" : "";
  return `${formatCount(count)}${suffix} file${count === 1 && !isTruncated ? "" : "s"}`;
}

/** A hollow dashed node on HEAD's lane, joined to the working-change row above and to the row below when linked. */
function renderWorkingGraph(rows: HistoryRowSet, isLinkedAbove: boolean, isLinkedBelow: boolean): string {
  const anchor = rows.workingAnchor ?? FIRST_LANE_ANCHOR;
  const width = rows.graphColumns * LANE_WIDTH;
  const middle = ROW_HEIGHT / 2;
  const above = isLinkedAbove ? renderWorkingLine(anchor, 0, middle) : "";
  const below = isLinkedBelow ? renderWorkingLine(anchor, middle, ROW_HEIGHT) : "";
  const node = `<circle class="graph-node ${laneClass(anchor.color)} is-working" cx="${columnX(anchor.lane)}" cy="${middle}" r="${NODE_RADIUS}"/>`;
  return `<svg class="graph" width="${width}" height="${ROW_HEIGHT}" viewBox="0 0 ${width} ${ROW_HEIGHT}" aria-hidden="true" focusable="false">${above}${below}${node}</svg>`;
}

/** A dashed vertical line on `anchor`'s lane, joining uncommitted changes to each other and to HEAD. */
function renderWorkingLine(anchor: GraphAnchor, y1: number, y2: number): string {
  const x = columnX(anchor.lane);
  return `<line class="graph-edge ${laneClass(anchor.color)} graph-working" x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/>`;
}

// ------------------------------------------------------------------ graph

/**
 * Decorative SVG; dashed `graph-gap` lines mark rows hidden by filters instead
 * of joining across them, short `graph-cut` stubs mark parents beyond the
 * loaded history, and lanes after the first `DRAWN_LANE_COUNT` share one
 * overflow column with hollow `is-overflow` nodes.
 */
function renderGraph(entry: VisibleGraphRow, columns: number, isMerge: boolean, isWorkingLinked: boolean): string {
  const { row } = entry;
  const width = columns * LANE_WIDTH;
  const middle = ROW_HEIGHT / 2;
  const upper = row.upper.map((segment) => renderSegment(segment, 0, middle, entry.hasHiddenAbove, false));
  if (isWorkingLinked) {
    upper.push(renderWorkingLine(row, 0, middle));
  }
  const lower = row.lower.map((segment) => renderSegment(segment, middle, ROW_HEIGHT, entry.hasHiddenBelow, segment.from === row.lane));
  const cuts = renderCutStubs(row, middle);
  const isOverflow = row.lane >= OVERFLOW_COLUMN;
  const nodeClass = `graph-node ${laneClass(row.color)}${isMerge ? " is-merge" : ""}${isOverflow ? " is-overflow" : ""}`;
  const node = `<circle class="${nodeClass}" cx="${columnX(row.lane)}" cy="${middle}" r="${NODE_RADIUS}"/>`;

  return `<svg class="graph" width="${width}" height="${ROW_HEIGHT}" viewBox="0 0 ${width} ${ROW_HEIGHT}" aria-hidden="true" focusable="false">${upper.join("")}${lower.join("")}${cuts.join("")}${node}</svg>`;
}

/**
 * Lanes in the overflow column share one position, so a line between two of
 * them would join unrelated lanes and is left out. A line between a drawn lane
 * and the overflow column fades out at the column's edge, unless it starts at
 * this row's node, which the column shows.
 */
function renderSegment(segment: GraphSegment, y1: number, y2: number, isGap: boolean, startsAtNode: boolean): string {
  const classes = `graph-edge ${laneClass(segment.color)}${isGap ? " graph-gap" : ""}`;
  const isFromOverflow = segment.from >= OVERFLOW_COLUMN;
  const isToOverflow = segment.to >= OVERFLOW_COLUMN;
  if (isFromOverflow && isToOverflow) {
    return "";
  }
  if (isToOverflow || (isFromOverflow && !startsAtNode)) {
    return renderClippedSegment(classes, laneX(segment.from), y1, laneX(segment.to), y2);
  }
  return `<line class="${classes}" x1="${columnX(segment.from)}" y1="${y1}" x2="${laneX(segment.to)}" y2="${y2}"/>`;
}

/** The part of a line left of the overflow column; exactly one end lies beyond its edge. */
function renderClippedSegment(classes: string, x1: number, y1: number, x2: number, y2: number): string {
  const edgeY = roundCoordinate(y1 + ((y2 - y1) * (OVERFLOW_EDGE_X - x1)) / (x2 - x1));
  const [startX, startY, endX, endY] = x1 < x2 ? [x1, y1, OVERFLOW_EDGE_X, edgeY] : [OVERFLOW_EDGE_X, edgeY, x2, y2];
  return `<line class="${classes} graph-clipped" x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}"/>`;
}

/** Short lines from the node, fanned by how far right of it each stub aims, within the node's column. */
function renderCutStubs(row: HistoryGraphRow, middle: number): readonly string[] {
  const widestOffset = Math.max(1, ...row.cuts.map((segment) => segment.to - segment.from));
  return row.cuts.map((segment) => {
    const fromX = columnX(segment.from);
    const endX = roundCoordinate(fromX + (CUT_STUB_SPREAD * (segment.to - segment.from)) / widestOffset);
    return `<line class="graph-edge ${laneClass(segment.color)} graph-cut" x1="${fromX}" y1="${middle}" x2="${endX}" y2="${CUT_STUB_END_Y}"/>`;
  });
}

/** Centre of a lane, which may lie beyond the drawn columns. */
function laneX(lane: number): number {
  return requireLaneNumber(lane) * LANE_WIDTH + LANE_WIDTH / 2;
}

/** Centre of the column that shows a lane. */
function columnX(lane: number): number {
  return laneX(Math.min(requireLaneNumber(lane), OVERFLOW_COLUMN));
}

/** Keeps computed coordinates short in the HTML. */
function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
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
<h2 id="history-files-heading" title="Net changes from the base to the replayed selection; double-click a file or press Enter on it to open its diff">Changed files</h2>
${comparison?.kind === "ready" && comparison.isIncomplete ? renderIncompleteNote() : ""}
${comparison?.kind === "ready" ? renderFileList(comparison.snapshotId, comparison.files) : ""}
${comparison?.kind === "blocked" ? renderBlockedPaths(comparison.paths) : ""}
</section>`;
}

/** Heads the changed files of a comparison that left unstaged changes past the path limit out. */
function renderIncompleteNote(): string {
  const limit = formatCount(WORKING_CHANGE_PATH_LIMIT);
  return `<p id="history-files-incomplete" class="truncated-note" title="More than ${limit} paths changed on disk; unstaged changes past the first ${limit} are left out of this comparison">Incomplete: only the first ${limit} changed files are compared</p>`;
}

function renderFileList(snapshotId: string, files: readonly ComparisonFile[]): string {
  if (files.length === 0) {
    return `<p class="empty" title="The selected changes cancel out">No net changes</p>`;
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
  const title = [label, ...details, "Double-click or press Enter to open its diff"].join("\n");

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
  const items = paths.map((path) => `<li title="${escapeHtml(`Conflicting path: ${path}`)}">${escapeHtml(path)}</li>`).join("");
  return `<p class="blocked-note" title="Change the selection or the base and the replay is tried again">No files can be opened until the replay applies cleanly. Conflicting paths:</p>
<ul class="blocked-paths">${items}</ul>`;
}

/** Selected commits in replay order (selection order until Git has ordered them), with merge-parent pickers. */
function renderReplay(view: HistoryView): string {
  const comparison = view.state.comparison;
  const hasOrder = comparison !== null && comparison.kind !== "needsBase";
  const oids = hasOrder ? comparison.orderedOids : view.state.selectedOids;
  const failingOid = comparison?.kind === "blocked" ? comparison.failingOid : null;
  const items = oids.map((oid) => {
    const isFailing = oid === failingOid;
    const failing = isFailing ? ` class="is-failing"` : "";
    const stoppedAt = isWorkingChangeId(oid) ? "these changes" : "this commit";
    const title = isFailing ? `${describeCommit(view, oid)}\nReplay stopped at ${stoppedAt}` : describeCommit(view, oid);
    return `<li data-oid="${escapeHtml(oid)}"${failing} title="${escapeHtml(title)}">${commitLabel(view, oid)}${renderMainlineSelect(view, oid)}</li>`;
  });
  const heading = hasOrder ? "Replay order" : "Selected commits";
  const headingTitle = hasOrder
    ? "The selected commits in the order Git replays them onto the base, oldest first"
    : "The selected commits, in selection order until Git has ordered them";

  return `<section id="history-replay" class="replay-pane" aria-labelledby="history-replay-heading">
<h2 id="history-replay-heading" title="${headingTitle}">${heading}</h2>
${items.length > 0 ? `<ol class="replay-order">${items.join("")}</ol>` : ""}
</section>`;
}

function renderMainlineSelect(view: HistoryView, oid: string): string {
  const commit = view.commitOf(oid);
  if (!commit || commit.parents.length < 2) {
    return "";
  }
  const chosen = view.state.mainlines.find((choice) => choice.oid === oid)?.parentNumber ?? 1;
  const options = commit.parents.map((parent, index) => {
    const subject = view.commitOf(parent)?.subject ?? "";
    const label = `Parent ${index + 1}: ${abbreviate(parent)} ${subject}`.trimEnd();
    const title = `Parent ${index + 1}: ${describeCommit(view, parent)}`;
    return `<option value="${index + 1}" title="${escapeHtml(title)}"${index + 1 === chosen ? " selected" : ""}>${escapeHtml(label)}</option>`;
  });
  const title = `Merge ${abbreviate(commit.oid)} is compared against parent ${chosen}: ${describeCommit(view, commit.parents[chosen - 1] ?? "")}`;
  return ` <select class="mainline-select" data-oid="${escapeHtml(commit.oid)}" aria-label="Compare merge ${shortHash(commit.oid)} against parent" title="${escapeHtml(title)}">${options.join("")}</select>`;
}

function renderDetails(view: HistoryView): string {
  const focusedOid = view.context.presentation.focusedOid;
  const commit = focusedOid === null ? undefined : view.commitOf(focusedOid);
  const summary = view.state.workingChanges;
  const isWorkingFocused = focusedOid !== null && isWorkingChangeId(focusedOid) && summary !== null;
  const empty = `<p class="empty" title="Click a commit, or move to it with ↑/↓, to show its hash, author, date and parents">Focus a commit to see its details</p>`;
  const body = commit ? renderCommitDetails(view, commit) : empty;
  return `<section id="history-details" class="details-pane" aria-labelledby="history-details-heading">
<h2 id="history-details-heading" title="The focused commit's subject, labels, hash, author, date and parents">Commit details</h2>
${isWorkingFocused ? renderWorkingDetails(focusedOid, summary) : body}
</section>`;
}

function renderWorkingDetails(id: WorkingChangeId, summary: WorkingChangeSummary): string {
  const label = workingChangeLabel(id);
  const description = escapeHtml(describeWorkingChange(id, summary));
  return `<p class="details-subject" title="${label}">${label}</p>
<p class="details-working" title="${description}">${description}</p>`;
}

function renderCommitDetails(view: HistoryView, commit: HistoryCommit): string {
  const parents = commit.parents
    .map((parent) => `<code title="${escapeHtml(describeCommit(view, parent))}">${shortHash(parent)}</code>`)
    .join(" ") || "none (root commit)";
  return `<p class="details-subject" title="${escapeHtml(commit.subject)}">${escapeHtml(commit.subject)}</p>
<p class="details-refs">${renderRefLabels(view, commit.oid)}</p>
<dl class="details-fields">
<dt>Hash</dt><dd title="${escapeHtml(commit.oid)}"><code>${escapeHtml(commit.oid)}</code></dd>
<dt>Author</dt><dd title="${escapeHtml(commit.author)}">${escapeHtml(commit.author)}</dd>
<dt>Date</dt><dd title="${escapeHtml(formatFullDate(commit.authoredDate))}">${renderDate(commit.authoredDate)}</dd>
<dt>Parents</dt><dd title="${commit.parents.length === 0 ? "A root commit has no parents" : escapeHtml(commit.parents.join("\n"))}">${parents}</dd>
</dl>`;
}

// ---------------------------------------------------------------- helpers

function option(value: string, label: string, isSelected: boolean): string {
  return `<option value="${escapeHtml(value)}"${isSelected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

/** Short hash plus subject when the commit is loaded, or a working change's label; escaped. */
function commitLabel(view: HistoryView, oid: string): string {
  if (isWorkingChangeId(oid)) {
    return `<span class="subject">${workingChangeLabel(oid)}</span>`;
  }
  const subject = view.commitOf(oid)?.subject;
  const suffix = subject === undefined ? "" : ` <span class="subject">${escapeHtml(subject)}</span>`;
  return `<code>${shortHash(oid)}</code>${suffix}`;
}

/** Full hash plus subject when the commit is loaded, or a working change's label; plain text, for tooltips. */
function describeCommit(view: HistoryView, oid: string): string {
  if (isWorkingChangeId(oid)) {
    return workingChangeLabel(oid);
  }
  const subject = view.commitOf(oid)?.subject;
  return subject === undefined ? oid : `${oid} ${subject}`;
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

/** `YYYY-MM-DD HH:MM:SS ±HH:MM` in the author's own time zone, for tooltips; unexpected formats are shown as given. */
function formatFullDate(isoDate: string): string {
  const match = ISO_SECOND_PATTERN.exec(isoDate);
  if (!match) {
    return isoDate;
  }
  const [, date, time, zone] = match;
  if (zone === undefined) {
    return `${date} ${time}`;
  }
  return `${date} ${time} ${zone === "Z" ? "+00:00" : zone}`;
}

function renderDate(isoDate: string): string {
  return `<time datetime="${escapeHtml(isoDate)}">${escapeHtml(formatDate(isoDate))}</time>`;
}

/** Plain text of escaped markup such as a status line, for its tooltip. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&");
}

/** How much of a truncated history is shown; the commit cap is the number of loaded commits. */
function describeLoadedCount(history: HistoryData): string {
  return `Showing the newest ${formatCount(history.commits.length)} commits`;
}

/** Counts that can reach the thousands, with `,` grouping regardless of the host's locale. */
function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
