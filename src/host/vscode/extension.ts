import * as path from "node:path";
import * as vscode from "vscode";
import { hasConflictMarkers } from "../../core/conflictParser";
import { listConflictedFiles } from "../../git/gitConflictedFiles";
import { HISTORY_DOCUMENT_SCHEME, HistoryDiffProvider } from "./historyDiffProvider";
import { registerHistoryLauncher } from "./historyLauncher";
import { candidateDirectories, discoverRepositoryRoots, findGitRepositoryRoot } from "./historyRepositoryDiscovery";
import { HISTORY_VIEW_ID, HistoryViewProvider, OPEN_HISTORY_COMMAND } from "./historyViewProvider";
import { MergeViewPanel } from "./mergeViewPanel";
import { SyntaxHighlighting } from "./syntaxHighlighting";
import { TwoWayDiffPanels } from "./twoWayDiffPanel";

const CONTEXT_HAS_CONFLICTS = "differ.hasConflicts";
const REFRESH_HISTORY_COMMAND = "differ.refreshHistory";
const RESOLVE_CONFLICTS_COMMAND = "differ.resolveConflicts";
const HISTORY_OUTPUT_CHANNEL = "Differ History";

/** Open merge views by document URI, settled or still loading. */
const openPanels = new Map<string, Promise<MergeViewPanel>>();
/** Kept so `deactivate` can wait for history cleanup; VS Code does not await subscription disposal. */
let historyView: HistoryViewProvider | undefined;

/** What the merge and history features share. */
interface Services {
  readonly mediaRoot: vscode.Uri;
  readonly highlighter: SyntaxHighlighting;
  readonly log: vscode.OutputChannel;
}

export function activate(context: vscode.ExtensionContext): void {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
  const log = vscode.window.createOutputChannel(HISTORY_OUTPUT_CHANNEL);
  const highlighter = new SyntaxHighlighting(path.join(context.extensionPath, "dist", "onig.wasm"), (message) => log.appendLine(message));
  const services: Services = { mediaRoot, highlighter, log };

  context.subscriptions.push(
    highlighter,
    log,
    vscode.commands.registerCommand("differ.openMergeView", () => openActiveMergeView(services)),
    vscode.commands.registerCommand(RESOLVE_CONFLICTS_COMMAND, () => resolveConflicts(services)),
    vscode.window.onDidChangeActiveTextEditor(updateConflictContext),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        updateConflictContext(vscode.window.activeTextEditor);
      }
    }),
  );

  updateConflictContext(vscode.window.activeTextEditor);
  activateHistory(context, services);
}

export async function deactivate(): Promise<void> {
  openPanels.clear();
  await historyView?.dispose();
  historyView = undefined;
}

function openActiveMergeView(services: Services): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a conflicted file first.");
    return;
  }
  if (!hasConflictMarkers(editor.document.getText())) {
    void vscode.window.showInformationMessage("Differ found no conflict markers in this file.");
    return;
  }
  void openMergeView(editor.document, services);
}

/** A conflicted file offered by the Resolve Conflicts picker. */
interface ConflictItem extends vscode.QuickPickItem {
  readonly filePath: string;
}

/** Lists the conflicted files of the open repositories and opens the chosen one in the merge view. */
async function resolveConflicts(services: Services): Promise<void> {
  const files = await findConflictedFiles(services.log);
  if (files.length === 0) {
    void vscode.window.showInformationMessage("Differ found no conflicted files.");
    return;
  }
  const picked = await vscode.window.showQuickPick(files.map(conflictItem), {
    title: "Resolve Conflicts",
    placeHolder: "Select a conflicted file to merge",
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.filePath));
  await openMergeView(document, services);
}

/** Conflicted files of every repository holding the workspace folders or the active editor; failures are logged. */
async function findConflictedFiles(log: vscode.OutputChannel): Promise<readonly string[]> {
  const logFailure = (directory: string, error: unknown): void => {
    log.appendLine(`Listing conflicts in ${directory} failed. ${error instanceof Error ? error.message : String(error)}`);
  };
  const { roots } = await discoverRepositoryRoots(candidateDirectories(), findGitRepositoryRoot, logFailure);
  const files: string[] = [];
  for (const root of roots) {
    try {
      files.push(...(await listConflictedFiles(root)));
    } catch (error) {
      logFailure(root, error);
    }
  }
  return files;
}

function conflictItem(filePath: string): ConflictItem {
  const directory = path.dirname(vscode.workspace.asRelativePath(filePath));
  return { label: path.basename(filePath), description: directory === "." ? "" : directory, filePath };
}

/** Shows the merge view of `document`, reusing an open one. */
async function openMergeView(document: vscode.TextDocument, services: Services): Promise<void> {
  const key = document.uri.toString();
  const existing = openPanels.get(key);
  if (existing) {
    // The call that started a failed open reports the failure.
    const panel = await existing.catch(() => null);
    panel?.reveal();
    return;
  }
  const opening = MergeViewPanel.create({
    document,
    mediaRoot: services.mediaRoot,
    highlighter: services.highlighter,
    log: (message) => services.log.appendLine(message),
    onDispose: () => forgetMergeView(key, opening),
  });
  openPanels.set(key, opening);
  try {
    await opening;
  } catch (error) {
    forgetMergeView(key, opening);
    const message = error instanceof Error ? error.message : String(error);
    services.log.appendLine(`Opening the merge view of ${document.uri.fsPath} failed. ${message}`);
    void vscode.window.showErrorMessage(`Differ could not open the merge view. ${message}`);
  }
}

/** Forgets the merge view `opening` of `key`; one that closed or failed late must not drop its replacement. */
function forgetMergeView(key: string, opening: Promise<MergeViewPanel>): void {
  if (openPanels.get(key) === opening) {
    openPanels.delete(key);
  }
}

/**
 * Registers the history panel, its Activity Bar launcher, its diff documents and panels, and commands. `deactivate` runs
 * before subscriptions are disposed, so history cleanup finishes while its log is still open.
 */
function activateHistory(context: vscode.ExtensionContext, { mediaRoot, highlighter, log }: Services): void {
  const diffPanels = new TwoWayDiffPanels({ mediaRoot, highlighter, log: (message) => log.appendLine(message) });
  const diffProvider = new HistoryDiffProvider(diffPanels);
  const view = new HistoryViewProvider({ mediaRoot, fileOpener: diffProvider, log });
  historyView = view;

  context.subscriptions.push(
    view,
    diffPanels,
    diffProvider,
    vscode.workspace.registerTextDocumentContentProvider(HISTORY_DOCUMENT_SCHEME, diffProvider),
    vscode.window.registerWebviewViewProvider(HISTORY_VIEW_ID, view),
    registerHistoryLauncher(() => view.reveal()),
    vscode.commands.registerCommand(OPEN_HISTORY_COMMAND, () => view.reveal()),
    vscode.commands.registerCommand(REFRESH_HISTORY_COMMAND, () => view.refresh()),
  );
}

/** Drives the `differ.hasConflicts` context key that shows the editor title button. */
function updateConflictContext(editor: vscode.TextEditor | undefined): void {
  const hasConflicts = editor !== undefined && hasConflictMarkers(editor.document.getText());
  void vscode.commands.executeCommand("setContext", CONTEXT_HAS_CONFLICTS, hasConflicts);
}
