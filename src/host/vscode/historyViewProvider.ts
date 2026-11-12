import { randomBytes, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { GitComparisonRepository } from "../../git/gitComparisonRepository";
import { HistoryGitError } from "../../git/historyGitCommand";
import { HistoryController } from "../../model/historyController";
import { shortHash } from "../../model/historyLabels";
import type { HistoryRepository, HistoryState } from "../../model/historyTypes";
import { VisibleCommitCache } from "../../model/historyVisibility";
import { HISTORY_PAGE_SIZE, HtmlHistoryRenderer } from "../../render/html/historyRenderer";
import type { HistoryPresentation } from "../../render/html/historyRenderer";
import type { HistoryFileOpener } from "./historyDiffProvider";
import { parseHistoryMessage } from "./historyMessages";
import type { HistoryMessage } from "./historyMessages";
import { candidateDirectories, discoverRepositoryRoots, findGitRepositoryRoot } from "./historyRepositoryDiscovery";
import type { RepositoryRootFinder } from "./historyRepositoryDiscovery";
import { describeHistoryStatus } from "./historyStatusBar";

export const HISTORY_VIEW_ID = "differ.history";
export const OPEN_HISTORY_COMMAND = "differ.openHistory";
/** Focus command VS Code derives from the contributed view ID. */
export const FOCUS_HISTORY_VIEW_COMMAND = `${HISTORY_VIEW_ID}.focus`;
/** Quiet period after a selection, base or merge-parent change before comparing. */
export const COMPARE_DELAY_MS = 150;

const NONCE_BYTES = 18;
const NO_REPOSITORY_FOUND = "No Git repository found in this workspace. Use Open… to choose a repository folder.";
/** Shown when a file is opened from a list whose comparison was replaced before the click arrived. */
export const COMPARISON_CHANGED_MESSAGE = "This comparison has changed — open the file again from the updated list.";

/** Port implementation the provider owns per repository root; disposal resolves once private files are gone. */
export interface ClosableHistoryRepository extends HistoryRepository {
  dispose(): Promise<void>;
}

/** Where technical details go; the `Differ History` OutputChannel in production. */
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

const INITIAL_PRESENTATION: HistoryPresentation = { search: "", branchOid: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE };

const EMPTY_STATE: HistoryState = {
  revision: 0,
  history: null,
  selectedOids: [],
  base: { kind: "automatic" },
  mainlines: [],
  comparison: null,
  operations: { isLoading: false, isResolvingBase: false, isComparing: false },
  error: null,
};

/**
 * Hosts the history panel: owns one controller and adapter per repository root, the active repository, presentation
 * state and the status-bar item. The webview only ever sees the active repository; every publication replaces its
 * document and carries a new wire revision that intents must echo before they may change anything.
 */
export class HistoryViewProvider implements vscode.WebviewViewProvider {
  private readonly renderer = new HtmlHistoryRenderer();
  private readonly visibility = new VisibleCommitCache();
  private readonly sessions: HistorySession[] = [];
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  private readonly workspaceSubscription: vscode.Disposable;
  private readonly createRepository: NonNullable<HistoryViewProviderOptions["createRepository"]>;
  private readonly findRepositoryRoot: RepositoryRootFinder;
  private view: vscode.WebviewView | undefined;
  private viewSubscriptions: vscode.Disposable[] = [];
  private active: HistorySession | undefined;
  /** The one discovery running; calls made meanwhile mark it stale so it runs once more with current folders. */
  private discovery: Promise<void> | undefined;
  private isDiscoveryStale = false;
  /** Discovery starts with the panel; folder changes before that are picked up then. */
  private hasDiscovered = false;
  /** Explains an empty repository list, such as Git missing. */
  private discoveryProblem: string | null = null;
  private published: Publication = { wireRevision: 0, sessionId: null, sessionWireRevision: 0 };
  private isDisposed = false;

  constructor(private readonly options: HistoryViewProviderOptions) {
    this.createRepository = options.createRepository
      ?? ((root, onCleanupError) => new GitComparisonRepository(root, { onCleanupError }));
    this.findRepositoryRoot = options.findRepositoryRoot ?? findGitRepositoryRoot;
    this.statusItem.command = OPEN_HISTORY_COMMAND;
    this.statusItem.tooltip = "Open Differ history";
    this.workspaceSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.hasDiscovered) {
        void this.discoverRepositories();
      }
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.detachView();
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.options.mediaRoot] };
    this.viewSubscriptions = [
      view.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message)),
      view.onDidDispose(() => this.detachView()),
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
    };
    this.sessions.push(session);
    return session;
  }

  private activate(session: HistorySession): void {
    this.active = session;
    const state = session.controller.getState();
    const needsLoad = state.history === null && !state.operations.isLoading;
    if (needsLoad) {
      void this.load(session);
      return;
    }
    this.publish();
  }

  /** Loads metadata, then drops selected commits that no longer exist and reports what changed. */
  private async load(session: HistorySession): Promise<void> {
    await this.follow(session.controller.load());
    this.revalidate(session);
  }

  private revalidate(session: HistorySession): void {
    const state = session.controller.getState();
    if (state.history === null || this.isDisposed) {
      return;
    }
    const known = new Set(state.history.commits.map((commit) => commit.oid));
    const isKnown = (oid: string | null): boolean => oid === null || known.has(oid);
    const { focusedOid, branchOid } = session.presentation;
    session.presentation = {
      ...session.presentation,
      focusedOid: isKnown(focusedOid) ? focusedOid : null,
      branchOid: isKnown(branchOid) ? branchOid : null,
    };
    const isPinnedBaseMissing = state.base.kind === "pinned" && !known.has(state.base.oid);
    if (isPinnedBaseMissing) {
      this.report(`The pinned base ${shortHash(state.base.oid)} is not reachable from the loaded refs; it stays pinned.`);
    }

    const kept = state.selectedOids.filter((oid) => known.has(oid));
    const missingCount = state.selectedOids.length - kept.length;
    if (missingCount > 0) {
      this.report(`${missingCount} selected commit(s) are no longer in the history of ${session.name}; they were deselected.`);
      session.controller.setSelection(kept);
    }
    // Also retries a comparison that failed before the refresh.
    this.scheduleCompare(session);
    this.publish();
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
      // An older revision means a newer document is already loading; republishing then could chain reloads.
      if (message.revision > wireRevision) {
        this.publish();
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
      case "repository":
        return this.switchRepository(message.repositoryId);
      case "chooseRepository":
        return this.chooseRepository();
    }
  }

  private select(oids: readonly string[], focusedOid: string | null): void {
    const session = this.publishedSession();
    const commits = session?.controller.getState().history?.commits;
    if (!session || !commits || oids.length > commits.length) {
      return;
    }
    const before = session.controller.getState();
    session.controller.setSelection(oids);
    const isSelectionChanged = session.controller.getState() !== before;
    const isFocusKnown = focusedOid === null || commits.some((commit) => commit.oid === focusedOid);
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
      await this.options.fileOpener.openFile(session.repository, comparison, file);
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
    const commits = session?.controller.getState().history?.commits ?? [];
    const isKnown = (oid: string | null): boolean => oid === null || commits.some((commit) => commit.oid === oid);
    if (!session || !isKnown(message.focusedOid)) {
      return;
    }

    const { search, branchOid, focusedOid, rowLimit } = message;
    const next: HistoryPresentation = isCurrent && isKnown(branchOid)
      ? { search, branchOid, focusedOid, rowLimit }
      : { ...session.presentation, focusedOid };
    const current = session.presentation;
    const isUnchanged = next.search === current.search && next.branchOid === current.branchOid
      && next.focusedOid === current.focusedOid && next.rowLimit === current.rowLimit;
    if (isUnchanged) {
      return;
    }
    session.presentation = next;
    this.publish();
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
    const visibleOids = this.visibility.visibleOids(state.history, presentation);
    const visible = new Set(visibleOids);
    const wireRevision = this.published.wireRevision + 1;
    const sessionId = session?.id ?? null;
    const isSameSession = sessionId === this.published.sessionId;
    const sessionWireRevision = isSameSession ? this.published.sessionWireRevision : wireRevision;
    this.published = { wireRevision, sessionId, sessionWireRevision };

    view.webview.html = this.renderer.render(state, {
      assets: {
        styleUri: this.mediaUri(view, "history.css"),
        scriptUri: this.mediaUri(view, "history.js"),
        cspSource: view.webview.cspSource,
      },
      nonce: randomBytes(NONCE_BYTES).toString("base64"),
      repositories: this.sessions.map((candidate) => ({ id: candidate.id, name: candidate.name })),
      activeRepositoryId: session?.id ?? null,
      presentation,
      visibleOids,
      hiddenSelectedCount: state.selectedOids.filter((oid) => !visible.has(oid)).length,
      wireRevision,
    });
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
  }

  private report(message: string): void {
    this.options.log.appendLine(message);
    void vscode.window.showWarningMessage(message);
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
    loadHistory: (signal) => logged(repository.loadHistory(signal)),
    resolveRef: (ref, signal) => logged(repository.resolveRef(ref, signal)),
    compare: (request, signal) => logged(repository.compare(request, signal)),
    readFile: (snapshotId, fileId, side, signal) => logged(repository.readFile(snapshotId, fileId, side, signal)),
    releaseSnapshot: (snapshotId) => repository.releaseSnapshot(snapshotId),
  };
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
