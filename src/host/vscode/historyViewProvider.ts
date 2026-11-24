import { randomBytes, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { GitComparisonRepository } from "../../git/gitComparisonRepository";
import { HistoryGitError } from "../../git/historyGitCommand";
import { selectBranchAction, selectBranchTarget } from "../../model/historyBranchCommits";
import type { BranchCommits, BranchCommitsLookup, SelectBranchAction } from "../../model/historyBranchCommits";
import { CHECKED_OUT_BRANCH, isPickedBranch, resolveBranchChoice } from "../../model/historyBranchFilter";
import type { BranchFilter } from "../../model/historyBranchFilter";
import { HistoryController } from "../../model/historyController";
import { shortHash } from "../../model/historyLabels";
import type { HistoryData, HistoryRepository, HistoryState } from "../../model/historyTypes";
import {
  isWorkingChangeId,
  presentWorkingChangeIds,
  WORKING_CHANGE_REPLAY_ORDER,
  workingChangeLabel,
} from "../../model/historyWorkingChanges";
import type { WorkingChangeId } from "../../model/historyWorkingChanges";
import { VisibleCommitCache, visibleWorkingChangeIds } from "../../model/historyVisibility";
import type { CommitFilter } from "../../model/historyVisibility";
import { HISTORY_PAGE_SIZE, HtmlHistoryRenderer } from "../../render/html/historyRenderer";
import type { HistoryPage, HistoryPageContext, HistoryPresentation, SelectBranchButton } from "../../render/html/historyRenderer";
import { GitIndexWatchers } from "./gitIndexWatchers";
import type { HistoryFileOpener } from "./historyDiffProvider";
import { parseHistoryMessage } from "./historyMessages";
import type { HistoryMessage } from "./historyMessages";
import { candidateDirectories, discoverRepositoryRoots, findGitRepositoryRoot } from "./historyRepositoryDiscovery";
import type { RepositoryRootFinder } from "./historyRepositoryDiscovery";
import { describeHistoryStatus } from "./historyStatusBar";

export const HISTORY_VIEW_ID = "jwDiffer.history";
export const OPEN_HISTORY_COMMAND = "jwDiffer.openHistory";
/** Focus command VS Code derives from the contributed view ID. */
export const FOCUS_HISTORY_VIEW_COMMAND = `${HISTORY_VIEW_ID}.focus`;
/** Quiet period after a selection, base or merge-parent change before comparing. */
export const COMPARE_DELAY_MS = 150;
/** Quiet period after a save, an index change or the window gaining focus before the working changes are read again. */
export const WORKING_REFRESH_DELAY_MS = 300;
/** `jwDiffer.*` setting capping the commits each history load reads; bounds extension-host memory on large repositories. */
export const MAX_COMMITS_SETTING = "historyMaxCommits";
export const DEFAULT_MAX_COMMITS = 20_000;
/** Matches the manifest's `minimum`, which VS Code does not enforce on hand-edited settings. */
export const MIN_MAX_COMMITS = 100;

const NONCE_BYTES = 18;
const NO_REPOSITORY_FOUND = "No Git repository found in this workspace. Use Open… to choose a repository folder.";
/** Shown when a file is opened from a list whose comparison was replaced before the click arrived. */
export const COMPARISON_CHANGED_MESSAGE = "This comparison has changed — open the file again from the updated list.";

/** Port implementation the provider owns per repository root; disposal resolves once private files are gone. */
export interface ClosableHistoryRepository extends HistoryRepository {
  /** What Select branch picks for `branchRef`, a full ref name or `HEAD`. */
  findBranchCommits(branchRef: string, signal: AbortSignal): Promise<BranchCommits>;
  /** Absolute path of the index file, watched so staging or committing elsewhere refreshes the working changes. */
  findIndexFile(): Promise<string>;
  /** The commit HEAD names now, null while unborn; a working-change refresh reloads the history when it moved. */
  readHeadOid(): Promise<string | null>;
  dispose(): Promise<void>;
}

/** Where technical details go; the `jw-differ History` OutputChannel in production. */
export interface HistoryLog {
  appendLine(value: string): void;
}

export interface HistoryViewProviderOptions {
  readonly mediaRoot: vscode.Uri;
  readonly fileOpener: HistoryFileOpener;
  readonly log: HistoryLog;
  /** Defaults to a `GitComparisonRepository` for `root`. */
  readonly createRepository?: (root: string, onCleanupError: (error: unknown) => void) => ClosableHistoryRepository;
  /** Defaults to Git. */
  readonly findRepositoryRoot?: RepositoryRootFinder;
}

/** One repository's controller, adapter and view-only choices; kept for the whole session. */
interface HistorySession {
  /** Opaque ID published to the webview instead of the path. */
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly repository: ClosableHistoryRepository;
  readonly controller: HistoryController;
  presentation: HistoryPresentation;
  compareTimer: ReturnType<typeof setTimeout> | undefined;
  /** Select branch's commits for one branch ref, read against one loaded history. */
  branchCommits: BranchCommitsEntry | null;
}

interface BranchCommitsEntry {
  readonly ref: string;
  readonly history: HistoryData;
  readonly lookup: BranchCommitsLookup;
  /** Cancels the read while `lookup` is reading. */
  readonly reading: AbortController;
}

/** What the last publication showed, so intents computed from it can be checked. */
interface Publication {
  readonly wireRevision: number;
  readonly sessionId: string | null;
  /**
   * First wire revision showing this session. Domain intents carry absolute values (the whole selection, a base, a
   * parent, a snapshot ID) that the controller validates, so any document of the same repository may send them; a
   * comparison starting or finishing must not swallow a click made on the page it replaced. Documents of another
   * session are ignored entirely.
   */
  readonly sessionWireRevision: number;
}

const INITIAL_PRESENTATION: HistoryPresentation = {
  search: "",
  branchChoice: CHECKED_OUT_BRANCH,
  branch: null,
  focusedOid: null,
  rowLimit: HISTORY_PAGE_SIZE,
};

const NO_SELECT_BRANCH_TITLE = "No repository is open to select a branch in";
const READING_BRANCH_COMMITS: BranchCommitsLookup = { kind: "reading" };
const FAILED_BRANCH_COMMITS: BranchCommitsLookup = { kind: "failed" };

const EMPTY_STATE: HistoryState = {
  revision: 0,
  history: null,
  workingChanges: null,
  selectedOids: [],
  base: { kind: "automatic" },
  mainlines: [],
  comparison: null,
  operations: { isLoading: false, isResolvingBase: false, isComparing: false },
  error: null,
};

/**
 * Hosts the history panel: owns one controller and adapter per repository root, the active repository, presentation
 * state and the status-bar item. The webview only ever sees the active repository; every publication carries a new
 * wire revision that intents must echo before they may change anything.
 *
 * The webview loads a whole document only when it has none or is hidden; reloading a shown one would flash it
 * unstyled until the stylesheet arrives, which is slow over a remote connection. Once the document reports ready,
 * publications post it updates that patch it in place. A hidden view gets each publication as a new document instead,
 * because VS Code recreates a hidden webview from its last assigned HTML and updates posted to it may be lost.
 */
export class HistoryViewProvider implements vscode.WebviewViewProvider {
  private readonly renderer = new HtmlHistoryRenderer();
  private readonly visibility = new VisibleCommitCache();
  private readonly sessions: HistorySession[] = [];
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  private readonly workspaceSubscription: vscode.Disposable;
  private readonly configurationSubscription: vscode.Disposable;
  private readonly openedFileSubscription: vscode.Disposable;
  /** The active repository's index; working-change rows also refresh on saves and when the window gains focus. */
  private readonly indexWatchers = new GitIndexWatchers(() => this.scheduleWorkingRefresh());
  private readonly workingChangeTriggers: vscode.Disposable;
  private workingRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly createRepository: NonNullable<HistoryViewProviderOptions["createRepository"]>;
  private readonly findRepositoryRoot: RepositoryRootFinder;
  private view: vscode.WebviewView | undefined;
  private viewSubscriptions: vscode.Disposable[] = [];
  private active: HistorySession | undefined;
  /** The HEAD commit each history was loaded for while it names no HEAD, so such a HEAD reloads only once. */
  private readonly unnamedHeadOids = new WeakMap<HistoryData, string>();
  /** The one discovery running; calls made meanwhile mark it stale so it runs once more with current folders. */
  private discovery: Promise<void> | undefined;
  private isDiscoveryStale = false;
  /** Discovery starts with the panel; folder changes before that are picked up then. */
  private hasDiscovered = false;
  /** Explains an empty repository list, such as Git missing. */
  private discoveryProblem: string | null = null;
  private published: Publication = { wireRevision: 0, sessionId: null, sessionWireRevision: 0 };
  /** The last document assigned to the view, which VS Code loads whenever it creates the webview. */
  private document: { readonly revision: number; readonly page: HistoryPage } | null = null;
  /** What the loaded document shows once it reported ready; null while a document is loading. */
  private shownPage: HistoryPage | null = null;
  private isDisposed = false;

  constructor(private readonly options: HistoryViewProviderOptions) {
    this.createRepository = options.createRepository
      ?? ((root, onCleanupError) => new GitComparisonRepository(root, { onCleanupError }));
    this.findRepositoryRoot = options.findRepositoryRoot ?? findGitRepositoryRoot;
    this.statusItem.command = OPEN_HISTORY_COMMAND;
    this.statusItem.tooltip = "Open jw-differ history";
    this.workspaceSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.hasDiscovered) {
        void this.discoverRepositories();
      }
    });
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`jwDiffer.${MAX_COMMITS_SETTING}`)) {
        this.reloadLoadedSessions();
      }
    });
    this.openedFileSubscription = options.fileOpener.onDidChangeOpenedFile(() => this.publish());
    this.workingChangeTriggers = vscode.Disposable.from(
      this.indexWatchers,
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleWorkingRefresh()),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.scheduleWorkingRefresh();
        }
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.detachView();
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.options.mediaRoot] };
    this.viewSubscriptions = [
      view.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message)),
      view.onDidDispose(() => this.detachView()),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          // Refreshes and Select branch reads are skipped while hidden.
          this.scheduleWorkingRefresh();
          this.readBranchCommits();
        } else {
          this.publish();
        }
      }),
    ];
    this.publish();
    void this.discoverRepositories();
  }

  /** Shows the panel; repositories are discovered once it resolves. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(FOCUS_HISTORY_VIEW_COMMAND);
  }

  /** Adds newly discovered repositories, then reloads the active one's metadata and revalidates its choices. */
  async refresh(): Promise<void> {
    const previous = this.active;
    await this.discoverRepositories();
    // A session that discovery just activated is already loading.
    if (this.active && this.active === previous) {
      await this.load(this.active);
    }
  }

  /** Cancels all work, then waits until every adapter has removed its private files. */
  async dispose(): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.detachView();
    this.statusItem.dispose();
    this.workspaceSubscription.dispose();
    this.configurationSubscription.dispose();
    this.openedFileSubscription.dispose();
    this.workingChangeTriggers.dispose();
    clearTimeout(this.workingRefreshTimer);
    const repositories = this.sessions.map((session) => {
      clearTimeout(session.compareTimer);
      session.controller.dispose();
      return session.repository.dispose();
    });
    await Promise.allSettled(repositories);
  }

  // ------------------------------------------------------------ repositories

  /** Finds roots for local workspace folders and the active editor, adding sessions for new ones. */
  private discoverRepositories(): Promise<void> {
    this.hasDiscovered = true;
    if (this.discovery) {
      this.isDiscoveryStale = true;
      return this.discovery;
    }
    this.discovery = this.discoverUntilCurrent().finally(() => {
      this.discovery = undefined;
    });
    return this.discovery;
  }

  private async discoverUntilCurrent(): Promise<void> {
    do {
      this.isDiscoveryStale = false;
      const result = await discoverRepositoryRoots(candidateDirectories(), this.findRepositoryRoot, (directory, error) => this.logInspectionError(directory, error));
      if (this.isDisposed) {
        return;
      }
      result.roots.forEach((root) => this.addSession(root));
      this.discoveryProblem = result.problem ?? NO_REPOSITORY_FOUND;
    } while (this.isDiscoveryStale);

    if (!this.active && this.sessions.length > 0) {
      this.activate(this.sessions[0]);
      return;
    }
    this.publish();
  }

  private async chooseRepository(): Promise<void> {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Open Repository History",
    });
    const folder = folders?.[0];
    if (folder === undefined || this.isDisposed) {
      return;
    }

    const { roots, problem } = await discoverRepositoryRoots([folder.fsPath], this.findRepositoryRoot, (directory, error) => this.logInspectionError(directory, error));
    if (this.isDisposed) {
      return;
    }
    const root = roots[0];
    if (root === undefined) {
      void vscode.window.showWarningMessage(problem ?? `${folder.fsPath} is not inside a Git repository.`);
      return;
    }
    this.activate(this.addSession(root));
  }

  /** Returns the existing session for `root`, so each repository keeps one controller and state per session. */
  private addSession(root: string): HistorySession {
    const existing = this.sessions.find((session) => session.root === root);
    if (existing) {
      return existing;
    }
    const repository = this.createRepository(root, (error) => this.logError(`Cleanup failed in ${root}`, error));
    const session: HistorySession = {
      id: randomUUID(),
      root,
      name: path.basename(root) || root,
      repository,
      controller: new HistoryController(withErrorLogging(repository, (error) => this.logError(root, error))),
      presentation: INITIAL_PRESENTATION,
      compareTimer: undefined,
      branchCommits: null,
    };
    this.sessions.push(session);
    return session;
  }

  private activate(session: HistorySession): void {
    if (this.active !== undefined && this.active !== session) {
      this.cancelBranchCommits(this.active);
      // The new index is watched once found; until then, and if it is never found, no other repository's is.
      this.indexWatchers.watch([]);
    }
    this.active = session;
    void this.watchIndexOf(session);
    const state = session.controller.getState();
    const needsLoad = state.history === null && !state.operations.isLoading;
    if (needsLoad) {
      void this.load(session);
      return;
    }
    // Its working changes went unread while another repository was shown.
    this.scheduleWorkingRefresh();
    this.publish();
  }

  /**
   * Loads metadata, then drops selected commits that no longer exist and reports what changed. The filters are fixed
   * before the loaded history is first published, so it never shows with a stale branch filter in between.
   */
  private async load(session: HistorySession): Promise<void> {
    const loaded = session.controller.load(configuredMaxCommits()).then(() => this.revalidatePresentation(session));
    await this.follow(loaded);
    this.revalidate(session);
  }

  /**
   * Applies a changed commit cap to every session that has tried to load, so a load that failed under the old cap is
   * retried; the others read it when activated.
   */
  private reloadLoadedSessions(): void {
    for (const session of this.sessions) {
      const state = session.controller.getState();
      const hasTriedLoading = state.history !== null || state.operations.isLoading || state.error?.operation === "load";
      if (hasTriedLoading) {
        void this.load(session);
      }
    }
  }

  private revalidate(session: HistorySession): void {
    const state = session.controller.getState();
    if (state.history === null || this.isDisposed) {
      return;
    }
    const known = new Set(state.history.commits.map((commit) => commit.oid));
    // A truncated history does not list a pinned base older than its cut, which still works for comparisons.
    const isPinnedBaseMissing = state.base.kind === "pinned" && !known.has(state.base.oid) && !state.history.isTruncated;
    if (isPinnedBaseMissing) {
      this.report(`The pinned base ${shortHash(state.base.oid)} is not reachable from the loaded refs; it stays pinned.`);
    }

    this.deselectUnavailable(session, state.selectedOids);
    // Also retries a comparison that failed before the refresh.
    this.scheduleCompare(session);
    this.publish();
  }

  /** Deselects commits gone from the history and working changes that no longer have changes, saying which. */
  private deselectUnavailable(session: HistorySession, selectedOids: readonly string[]): void {
    const kept = selectedOids.filter((oid) => session.controller.isSelectable(oid));
    if (kept.length === selectedOids.length) {
      return;
    }
    const missingCount = selectedOids.filter((oid) => !isWorkingChangeId(oid) && !kept.includes(oid)).length;
    if (missingCount > 0) {
      this.inform(`${missingCount} selected commit(s) are no longer in the history of ${session.name}; they were deselected.`);
    }
    const emptiedLabels = selectedOids.filter(isWorkingChangeId).filter((id) => !kept.includes(id)).map(workingChangeLabel);
    if (emptiedLabels.length > 0) {
      this.inform(`${emptiedLabels.join(" and ")} of ${session.name} no longer have changes; they were deselected.`);
    }
    session.controller.setSelection(kept);
  }

  /**
   * Drops a focus the loaded history lacks and resolves the branch choice against it. The checked-out branch choice
   * follows HEAD: its branch, or its commit when detached, and all branches while HEAD's commit is not loaded. A picked
   * branch is kept by ref, so it follows the branch; once deleted or cut off by the cap it becomes All branches, so the
   * filter never jumps to another branch the user did not pick.
   */
  private revalidatePresentation(session: HistorySession): void {
    const { history } = session.controller.getState();
    const isLoaded = (oid: string): boolean => session.controller.hasCommit(oid);
    const { focusedOid, branchChoice } = session.presentation;
    const branch = resolveBranchChoice(history, branchChoice, isLoaded);
    const isPickedBranchGone = branch === null && isPickedBranch(branchChoice);
    session.presentation = {
      ...session.presentation,
      focusedOid: focusedOid !== null && session.controller.isSelectable(focusedOid) ? focusedOid : null,
      branchChoice: isPickedBranchGone ? null : branchChoice,
      branch,
    };
  }

  // ---------------------------------------------------------------- messages

  private async handleMessage(raw: unknown): Promise<void> {
    const message = parseHistoryMessage(raw);
    if (message === null) {
      this.options.log.appendLine("Ignored a malformed history panel message.");
      return;
    }
    const { wireRevision, sessionWireRevision } = this.published;
    if (message.type === "ready") {
      // Any other revision is a replaced document whose updates would be lost.
      if (this.document !== null && message.revision === this.document.revision) {
        this.shownPage = this.document.page;
        // Only publications made while it loaded are missing: a needless one would make its next intents stale.
        if (this.published.wireRevision !== this.document.revision) {
          this.publish();
        }
      }
      return;
    }
    const isSameSession = message.revision >= sessionWireRevision && message.revision <= wireRevision;
    if (!isSameSession) {
      return;
    }
    if (message.type === "presentation") {
      this.applyPresentation(message, message.revision === wireRevision);
      return;
    }
    try {
      await this.dispatch(message);
    } catch (error) {
      this.logError("History request failed", error);
    }
  }

  private async dispatch(message: Exclude<HistoryMessage, { type: "ready" | "presentation" }>): Promise<void> {
    switch (message.type) {
      case "select":
        return this.select(message.oids, message.focusedOid);
      case "base":
        return this.setBase(message.ref);
      case "mainline":
        return this.setMainline(message.oid, message.parentNumber);
      case "openFile":
        return this.openFile(message.snapshotId, message.fileId);
      case "refresh":
        return this.refresh();
      case "selectBranch":
        return this.selectBranch();
      case "repository":
        return this.switchRepository(message.repositoryId);
      case "chooseRepository":
        return this.chooseRepository();
    }
  }

  /** Selects `oids`, leaving out working changes whose row emptied after the page that sent them was shown. */
  private select(oids: readonly string[], focusedOid: string | null): void {
    const session = this.publishedSession();
    const commits = session?.controller.getState().history?.commits;
    if (!session || !commits || oids.length > commits.length + WORKING_CHANGE_REPLAY_ORDER.length) {
      return;
    }
    const before = session.controller.getState();
    session.controller.setSelection(oids.filter((oid) => !isWorkingChangeId(oid) || session.controller.isSelectable(oid)));
    const isSelectionChanged = session.controller.getState() !== before;
    const isFocusKnown = focusedOid === null || session.controller.isSelectable(focusedOid);
    const isFocusChanged = isFocusKnown && focusedOid !== session.presentation.focusedOid;
    if (!isSelectionChanged && !isFocusChanged) {
      return;
    }
    if (isFocusChanged) {
      session.presentation = { ...session.presentation, focusedOid };
    }
    if (isSelectionChanged) {
      this.scheduleCompare(session);
    }
    this.publish();
  }

  /** Replaces the selection with the branch's commits and, when it is checked out, its working changes. */
  private selectBranch(): void {
    const session = this.publishedSession();
    if (!session) {
      return;
    }
    const action = this.selectBranchActionOf(session);
    if (action.ids.length === 0) {
      return;
    }
    if (action.unloadedCount > 0) {
      const count = action.unloadedCount;
      void vscode.window.showInformationMessage(`${count} older commit(s) of the branch are beyond the loaded history and were not selected.`);
    }
    this.select(action.ids, action.ids[0] ?? null);
  }

  private async setBase(ref: string | null): Promise<void> {
    const session = this.publishedSession();
    if (!session) {
      return;
    }
    await this.follow(session.controller.setBase(ref));
    this.scheduleCompare(session);
  }

  private setMainline(oid: string, parentNumber: number): void {
    const session = this.publishedSession();
    if (!session) {
      return;
    }
    session.controller.setMainline(oid, parentNumber);
    this.scheduleCompare(session);
    this.publish();
  }

  private async openFile(snapshotId: string, fileId: string): Promise<void> {
    const session = this.publishedSession();
    const comparison = session?.controller.getState().comparison;
    if (!session) {
      return;
    }
    const isCurrentSnapshot = comparison?.kind === "ready" && comparison.snapshotId === snapshotId;
    if (!isCurrentSnapshot) {
      void vscode.window.showInformationMessage(COMPARISON_CHANGED_MESSAGE);
      return;
    }
    const file = comparison.files.find((candidate) => candidate.id === fileId);
    if (!file) {
      return;
    }
    try {
      await this.options.fileOpener.openFile(session, comparison, file);
    } catch (error) {
      this.logError("Could not open the file comparison", error);
      if (!isCancellation(error)) {
        void vscode.window.showErrorMessage(userMessage(error));
      }
    }
  }

  private switchRepository(repositoryId: string): void {
    const session = this.sessions.find((candidate) => candidate.id === repositoryId);
    if (session && session !== this.active) {
      this.activate(session);
    }
  }

  /**
   * Applies view-only choices. A stale message of the same session may still move the focus, which never changes the
   * comparison; its search, branch and paging values are dropped because they were computed from an older document.
   */
  private applyPresentation(message: Extract<HistoryMessage, { type: "presentation" }>, isCurrent: boolean): void {
    const session = this.publishedSession();
    if (!session) {
      return;
    }
    const isKnown = (oid: string | null): boolean => oid === null || session.controller.isSelectable(oid);
    if (!isKnown(message.focusedOid)) {
      return;
    }

    const { search, focusedOid, rowLimit, branch: branchChoice } = message;
    const current = session.presentation;
    const branch = this.branchFilterOf(session, branchChoice);
    const isApplied = isCurrent && branch !== undefined;
    const next: HistoryPresentation = isApplied
      ? { search, branchChoice, branch, focusedOid, rowLimit }
      : { ...current, focusedOid };
    const isUnchanged = next.search === current.search && next.branchChoice === current.branchChoice
      && next.focusedOid === current.focusedOid && next.rowLimit === current.rowLimit;
    if (isUnchanged) {
      return;
    }
    session.presentation = next;
    this.publish();
  }

  /**
   * The filter for `choice`: the current one when the choice is unchanged, so most messages skip the lookup; null for
   * all branches or a checked-out branch that is not loaded; undefined when the loaded history has no such branch.
   */
  private branchFilterOf(session: HistorySession, choice: string | null): BranchFilter | null | undefined {
    const { branchChoice, branch } = session.presentation;
    if (choice === branchChoice) {
      return branch;
    }
    const history = session.controller.getState().history;
    const filter = resolveBranchChoice(history, choice, (oid) => session.controller.hasCommit(oid));
    const isMissingBranch = filter === null && isPickedBranch(choice);
    return isMissingBranch ? undefined : filter;
  }

  /** The session the last publication showed, if it is still the active one. */
  private publishedSession(): HistorySession | undefined {
    const session = this.active;
    return session && session.id === this.published.sessionId ? session : undefined;
  }

  // ------------------------------------------------------------- comparison

  /** Restarts the quiet period; compares only when the current selection has no comparison yet. */
  private scheduleCompare(session: HistorySession): void {
    clearTimeout(session.compareTimer);
    if (this.isDisposed) {
      return;
    }
    session.compareTimer = setTimeout(() => {
      session.compareTimer = undefined;
      const state = session.controller.getState();
      const needsComparison = state.comparison === null && state.selectedOids.length > 0;
      if (needsComparison) {
        void this.follow(session.controller.compare());
      }
    }, COMPARE_DELAY_MS);
  }

  // --------------------------------------------------------- working changes

  /** Watches the index of `session` while it is the active one. */
  private async watchIndexOf(session: HistorySession): Promise<void> {
    try {
      const indexFile = await session.repository.findIndexFile();
      if (this.active === session && !this.isDisposed) {
        this.indexWatchers.watch([indexFile]);
      }
    } catch (error) {
      this.logError(`Could not find the Git index of ${session.root}`, error);
    }
  }

  /** Restarts the quiet period before rereading the active repository's working changes; none while hidden. */
  private scheduleWorkingRefresh(): void {
    clearTimeout(this.workingRefreshTimer);
    if (this.isDisposed || !this.view?.visible) {
      return;
    }
    this.workingRefreshTimer = setTimeout(() => {
      this.workingRefreshTimer = undefined;
      if (this.active) {
        void this.refreshWorkingChanges(this.active);
      }
    }, WORKING_REFRESH_DELAY_MS);
  }

  /** Rereads the working changes of a loaded session; deselects and unfocuses emptied ones and compares again. */
  private async refreshWorkingChanges(session: HistorySession): Promise<void> {
    const before = session.controller.getState();
    const isLoaded = before.history !== null && !before.operations.isLoading;
    if (!isLoaded) {
      // A load reads them too.
      return;
    }
    const headOid = await this.readHeadOid(session);
    const current = session.controller.getState();
    if (current.operations.isLoading || current.history !== before.history) {
      // A load that ran meanwhile reads, or read, them too.
      return;
    }
    if (headOid !== undefined && this.hasHeadMoved(before.history, headOid)) {
      if (this.active === session && !this.isDisposed) {
        await this.load(session);
        this.rememberUnnamedHead(session, before.history, headOid);
      }
      return;
    }
    await session.controller.refreshWorkingChanges();
    const after = session.controller.getState();
    const isUnchanged = after.workingChanges === before.workingChanges;
    if (isUnchanged || this.isDisposed || this.active !== session) {
      return;
    }
    this.deselectUnavailable(session, after.selectedOids);
    const { focusedOid } = session.presentation;
    if (focusedOid !== null && !session.controller.isSelectable(focusedOid)) {
      session.presentation = { ...session.presentation, focusedOid: null };
    }
    this.scheduleCompare(session);
    this.publish();
  }

  /** The commit HEAD names now, null while its branch has none; undefined, and logged, when the read fails. */
  private async readHeadOid(session: HistorySession): Promise<string | null | undefined> {
    try {
      return await session.repository.readHeadOid();
    } catch (error) {
      this.logError(`Could not read HEAD of ${session.root}`, error);
      return undefined;
    }
  }

  /**
   * Whether HEAD at `headOid` names another commit than `history` records, as after a commit elsewhere. While `history`
   * names no HEAD, as for one attached to a ref outside the list, it has moved once it names a commit, unless `history`
   * was loaded for that commit.
   */
  private hasHeadMoved(history: HistoryData, headOid: string | null): boolean {
    if (history.head !== null) {
      return headOid !== history.head.oid;
    }
    return headOid !== null && this.unnamedHeadOids.get(history) !== headOid;
  }

  /** Records that the history reloaded for HEAD at `headOid` still names no HEAD; a failed reload records nothing. */
  private rememberUnnamedHead(session: HistorySession, before: HistoryData, headOid: string | null): void {
    const { history } = session.controller.getState();
    if (history !== null && history !== before && history.head === null && headOid !== null) {
      this.unnamedHeadOids.set(history, headOid);
    }
  }

  // ----------------------------------------------------------- select branch

  /** What Select branch does in `session` now; starts reading the target's commits when they are not known yet. */
  private selectBranchActionOf(session: HistorySession): SelectBranchAction {
    const { history, workingChanges } = session.controller.getState();
    const isLoaded = (oid: string): boolean => session.controller.hasCommit(oid);
    const { branchChoice, branch } = session.presentation;
    const target = selectBranchTarget(history, branchChoice, branch, isLoaded);
    const lookup = target === null || history === null ? READING_BRANCH_COMMITS : this.lookUpBranchCommits(session, target.ref, history);
    return selectBranchAction(target, lookup, presentWorkingChangeIds(workingChanges), isLoaded);
  }

  /**
   * The commits of `ref` as read against `history`, or reading when not read yet; each newly loaded history reads them
   * again, as either branch may have moved. Nothing is read while the view is hidden. A finished read publishes.
   */
  private lookUpBranchCommits(session: HistorySession, ref: string, history: HistoryData): BranchCommitsLookup {
    const known = session.branchCommits;
    if (known?.ref === ref && known.history === history) {
      return known.lookup;
    }
    if (!this.view?.visible) {
      return READING_BRANCH_COMMITS;
    }
    known?.reading.abort();
    const entry: BranchCommitsEntry = { ref, history, lookup: READING_BRANCH_COMMITS, reading: new AbortController() };
    session.branchCommits = entry;
    void session.repository.findBranchCommits(ref, entry.reading.signal).then(
      (commits): BranchCommitsLookup => commits,
      (error: unknown): BranchCommitsLookup => {
        if (!isCancellation(error)) {
          this.logError(`Could not find the commits of ${ref} in ${session.root}`, error);
        }
        return FAILED_BRANCH_COMMITS;
      },
    ).then((lookup) => {
      const isCurrent = session.branchCommits === entry && !this.isDisposed;
      if (isCurrent) {
        session.branchCommits = { ...entry, lookup };
        if (this.active === session) {
          this.publish();
        }
      }
    });
    return READING_BRANCH_COMMITS;
  }

  /** Starts reading the active repository's Select branch commits unless they are known; a finished read publishes. */
  private readBranchCommits(): void {
    if (this.active) {
      this.selectBranchActionOf(this.active);
    }
  }

  /** Stops a read no shown page waits for; the next publication of `session` starts it again. */
  private cancelBranchCommits(session: HistorySession): void {
    if (session.branchCommits?.lookup === READING_BRANCH_COMMITS) {
      session.branchCommits.reading.abort();
      session.branchCommits = null;
    }
  }

  /** Publishes the synchronous state change now and the settled state once `operation` completes. */
  private async follow(operation: Promise<void>): Promise<void> {
    this.publish();
    try {
      await operation;
    } catch (error) {
      this.logError("History operation failed", error);
    }
    this.publish();
  }

  // ------------------------------------------------------------- publishing

  private publish(): void {
    if (this.isDisposed) {
      return;
    }
    this.updateStatusBar();
    const view = this.view;
    if (!view) {
      return;
    }

    const session = this.active;
    const state = session?.controller.getState() ?? this.emptyState();
    const presentation = session?.presentation ?? INITIAL_PRESENTATION;
    const filter = { search: presentation.search, branchOid: presentation.branch?.tipOid ?? null };
    const visibleOids = this.visibility.visibleOids(state.history, filter);
    const visibleWorkingIds = visibleWorkingChangeIds(state.history, state.workingChanges, presentation.search, presentation.branch);
    const wireRevision = this.published.wireRevision + 1;
    const sessionId = session?.id ?? null;
    const isSameSession = sessionId === this.published.sessionId;
    const sessionWireRevision = isSameSession ? this.published.sessionWireRevision : wireRevision;
    this.published = { wireRevision, sessionId, sessionWireRevision };
    const context: HistoryPageContext = {
      repositories: this.sessions.map((candidate) => ({ id: candidate.id, name: candidate.name })),
      activeRepositoryId: sessionId,
      presentation,
      visibleOids,
      visibleWorkingIds,
      hiddenSelectedCount: this.hiddenSelectedCount(state, filter, visibleWorkingIds),
      wireRevision,
      openedFile: this.options.fileOpener.openedFile,
      selectBranch: this.selectBranchButton(session),
    };

    if (!view.visible || this.document === null) {
      const document = this.renderer.render(state, {
        ...context,
        assets: {
          styleUri: this.mediaUri(view, "history.css"),
          scriptUri: this.mediaUri(view, "history.js"),
          cspSource: view.webview.cspSource,
        },
        fuzzyMatchScriptUri: this.mediaUri(view, "fuzzyMatch.js"),
        branchFilterScriptUri: this.mediaUri(view, "branchFilter.js"),
        nonce: randomBytes(NONCE_BYTES).toString("base64"),
      });
      view.webview.html = document.html;
      this.document = { revision: wireRevision, page: document.page };
      this.shownPage = null;
      return;
    }
    // A loading document announces itself with `ready`, which publishes again if it missed a publication.
    if (this.shownPage !== null) {
      const patch = this.renderer.update(state, context, this.shownPage);
      void view.webview.postMessage(patch.update);
      this.shownPage = patch.page;
    }
  }

  private selectBranchButton(session: HistorySession | undefined): SelectBranchButton {
    if (session === undefined) {
      return { isEnabled: false, title: NO_SELECT_BRANCH_TITLE };
    }
    const action = this.selectBranchActionOf(session);
    return { isEnabled: action.ids.length > 0, title: action.title };
  }

  /** Selected commits and working changes that the filters hide. */
  private hiddenSelectedCount(state: HistoryState, filter: CommitFilter, visibleWorkingIds: readonly WorkingChangeId[]): number {
    const commitOids = state.selectedOids.filter((oid) => !isWorkingChangeId(oid));
    const hiddenWorkingCount = state.selectedOids
      .filter((oid) => isWorkingChangeId(oid) && !visibleWorkingIds.some((id) => id === oid)).length;
    return this.visibility.hiddenCount(state.history, filter, commitOids) + hiddenWorkingCount;
  }

  /** Placeholder state that explains why no repository is shown. */
  private emptyState(): HistoryState {
    const problem = this.discoveryProblem;
    return problem === null ? EMPTY_STATE : { ...EMPTY_STATE, error: { operation: "load", message: problem } };
  }

  private mediaUri(view: vscode.WebviewView, fileName: string): string {
    return view.webview.asWebviewUri(vscode.Uri.joinPath(this.options.mediaRoot, fileName)).toString();
  }

  private updateStatusBar(): void {
    const session = this.active;
    if (!session) {
      this.statusItem.hide();
      return;
    }
    this.statusItem.text = describeHistoryStatus(session.name, session.controller.getState());
    this.statusItem.show();
  }

  private detachView(): void {
    this.viewSubscriptions.forEach((subscription) => subscription.dispose());
    this.viewSubscriptions = [];
    this.view = undefined;
    this.document = null;
    this.shownPage = null;
  }

  private report(message: string): void {
    this.options.log.appendLine(message);
    void vscode.window.showWarningMessage(message);
  }

  /** Logs and shows `message` as news rather than a problem, such as a selection following the repository. */
  private inform(message: string): void {
    this.options.log.appendLine(message);
    void vscode.window.showInformationMessage(message);
  }

  private logInspectionError(directory: string, error: unknown): void {
    this.logError(`Could not inspect ${directory}`, error);
  }

  private logError(context: string, error: unknown): void {
    this.options.log.appendLine(`${context}: ${errorDetail(error)}`);
  }
}

/** Logs every failure's detail before the controller reduces it to a message; cancellations stay quiet. */
function withErrorLogging(repository: HistoryRepository, log: (error: unknown) => void): HistoryRepository {
  const logged = <T>(operation: Promise<T>): Promise<T> =>
    operation.catch((error: unknown) => {
      if (!isCancellation(error)) {
        log(error);
      }
      throw error;
    });
  return {
    loadHistory: (maxCommits, signal) => logged(repository.loadHistory(maxCommits, signal)),
    readWorkingChanges: (signal) => logged(repository.readWorkingChanges(signal)),
    resolveRef: (ref, signal) => logged(repository.resolveRef(ref, signal)),
    compare: (request, signal) => logged(repository.compare(request, signal)),
    readFile: (snapshotId, fileId, side, signal) => logged(repository.readFile(snapshotId, fileId, side, signal)),
    releaseSnapshot: (snapshotId) => repository.releaseSnapshot(snapshotId),
  };
}

/** The configured commit cap; values below the minimum are raised to it and non-numbers fall back to the default. */
function configuredMaxCommits(): number {
  const value = vscode.workspace.getConfiguration("jwDiffer").get<unknown>(MAX_COMMITS_SETTING, DEFAULT_MAX_COMMITS);
  const isNumber = typeof value === "number" && Number.isFinite(value);
  return isNumber ? Math.max(MIN_MAX_COMMITS, Math.floor(value)) : DEFAULT_MAX_COMMITS;
}

function isCancellation(error: unknown): boolean {
  return error instanceof HistoryGitError && error.kind === "cancelled";
}

function userMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Technical detail for the log; errors from the Git layer carry an unredacted `detail`. */
function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const detail = (error as { readonly detail?: unknown }).detail;
  return typeof detail === "string" && detail !== "" ? `${error.message}\n${detail}` : error.stack ?? error.message;
}
