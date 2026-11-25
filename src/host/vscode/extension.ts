import * as path from "node:path";
import * as vscode from "vscode";
import { hasConflictMarkers } from "../../core/conflictParser";
import { findIndexFile, listConflictedFiles } from "../../git/gitConflictedFiles";
import { useGitExecutableLocator } from "../../git/historyGitCommand";
import { ConflictedFilesContext, type ConflictedFilesScan } from "./conflictedFilesContext";
import { GitExecutableLocator } from "./gitExecutableLocator";
import { HISTORY_DOCUMENT_SCHEME, HistoryDiffProvider } from "./historyDiffProvider";
import { candidateDirectories, discoverRepositoryRoots, findGitRepositoryRoot } from "./historyRepositoryDiscovery";
import { HISTORY_VIEW_ID, HistoryViewProvider, OPEN_HISTORY_COMMAND } from "./historyViewProvider";
import { MergeViewPanel } from "./mergeViewPanel";
import { registerScmChangeCommands } from "./scmChangeCommands";
import { SyntaxHighlighting } from "./syntaxHighlighting";
import { TwoWayDiffPanels } from "./twoWayDiffPanel";

const CONTEXT_HAS_CONFLICTS = "jwDiffer.hasConflicts";
const REFRESH_HISTORY_COMMAND = "jwDiffer.refreshHistory";
const RESOLVE_CONFLICTS_COMMAND = "jwDiffer.resolveConflicts";
const RESOLVE_CONFLICT_IN_FILE_COMMAND = "jwDiffer.resolveConflictInFile";
const HISTORY_OUTPUT_CHANNEL = "jw-differ History";

/** Open merge views by document URI, settled or still loading. */
const openPanels = new Map<string, Promise<MergeViewPanel>>();
/** Kept so `deactivate` can wait for history cleanup; VS Code does not await subscription disposal. */
let historyView: HistoryViewProvider | undefined;

/** What the merge and history features share. */
interface Services {
  readonly mediaRoot: vscode.Uri;
  readonly highlighter: SyntaxHighlighting;
  readonly log: vscode.OutputChannel;
  readonly conflictedFiles: ConflictedFilesContext;
}

export function activate(context: vscode.ExtensionContext): void {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
  const log = vscode.window.createOutputChannel(HISTORY_OUTPUT_CHANNEL);
  // Before anything runs Git: the conflicted-files context below refreshes on creation.
  const gitExecutable = new GitExecutableLocator((line) => log.appendLine(line));
  const restorePlainGit = useGitExecutableLocator(() => gitExecutable.locate());
  const highlighter = new SyntaxHighlighting(
    path.join(context.extensionPath, "dist", "onig.wasm"),
    path.join(context.extensionPath, "media", "themes"),
    path.join(context.extensionPath, "media", "grammars"),
    (message) => log.appendLine(message),
  );
  const conflictedFiles = new ConflictedFilesContext(scanConflictedFiles, (line) => log.appendLine(line));
  const services: Services = { mediaRoot, highlighter, log, conflictedFiles };

  context.subscriptions.push(
    gitExecutable,
    new vscode.Disposable(restorePlainGit),
    highlighter,
    log,
    conflictedFiles,
    vscode.commands.registerCommand("jwDiffer.openMergeView", () => openActiveMergeView(services)),
    vscode.commands.registerCommand(RESOLVE_CONFLICTS_COMMAND, () => resolveConflicts(services)),
    vscode.commands.registerCommand(RESOLVE_CONFLICT_IN_FILE_COMMAND, (target?: ResolveTarget) => resolveConflictInFile(target, services)),
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
    void vscode.window.showInformationMessage("jw-differ found no conflict markers in this file.");
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
    void vscode.window.showInformationMessage("jw-differ found no conflicted files.");
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
  await openFileMergeView(vscode.Uri.file(picked.filePath), services);
}

/** What a context menu passes: a file's URI from the Explorer or an editor tab, a resource state from Source Control. */
type ResolveTarget = vscode.Uri | vscode.SourceControlResourceState;

/** Opens the merge view of the file a context menu was opened on; without one, as from a key binding, the active file's. */
async function resolveConflictInFile(target: ResolveTarget | undefined, services: Services): Promise<void> {
  if (!target) {
    openActiveMergeView(services);
    return;
  }
  await openFileMergeView(target instanceof vscode.Uri ? target : target.resourceUri, services);
}

/** Opens the merge view of the file at `uri`; one that cannot be opened, such as a deleted side's, is reported. */
async function openFileMergeView(uri: vscode.Uri, services: Services): Promise<void> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.log.appendLine(`Opening ${uri.fsPath} failed. ${message}`);
    void vscode.window.showErrorMessage(`jw-differ could not open ${path.basename(uri.fsPath)}. ${message}`);
    return;
  }
  await openMergeView(document, services);
}

/** Conflicted files of every repository holding the workspace folders or the active editor; failures are logged. */
async function findConflictedFiles(log: vscode.OutputChannel): Promise<readonly string[]> {
  return (await scanConflictedFiles((failure) => log.appendLine(failure))).files;
}

/**
 * The conflicted files and index files of the repositories of the workspace and the active editor; each failure is
 * reported through `onFailure`.
 */
async function scanConflictedFiles(onFailure: (failure: string) => void): Promise<ConflictedFilesScan> {
  const reportFailure = (action: string, directory: string, error: unknown): void => {
    onFailure(`${action} ${directory} failed. ${error instanceof Error ? error.message : String(error)}`);
  };
  const reportListingFailure = (directory: string, error: unknown): void => reportFailure("Listing conflicts in", directory, error);
  const { roots } = await discoverRepositoryRoots(candidateDirectories(), findGitRepositoryRoot, reportListingFailure);
  const files: string[] = [];
  const indexFiles: string[] = [];
  for (const root of roots) {
    try {
      files.push(...(await listConflictedFiles(root)));
    } catch (error) {
      reportListingFailure(root, error);
    }
    // Apart from the listing, so a repository whose index cannot be found still has its conflicts listed.
    try {
      indexFiles.push(await findIndexFile(root));
    } catch (error) {
      reportFailure("Finding the Git index of", root, error);
    }
  }
  return { files, indexFiles };
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
    onDispose: () => {
      forgetMergeView(key, opening);
      // Applying a complete merge stages the file before closing the view.
      services.conflictedFiles.refresh();
    },
  });
  openPanels.set(key, opening);
  try {
    await opening;
  } catch (error) {
    forgetMergeView(key, opening);
    const message = error instanceof Error ? error.message : String(error);
    services.log.appendLine(`Opening the merge view of ${document.uri.fsPath} failed. ${message}`);
    void vscode.window.showErrorMessage(`jw-differ could not open the merge view. ${message}`);
  }
}

/** Forgets the merge view `opening` of `key`; one that closed or failed late must not drop its replacement. */
function forgetMergeView(key: string, opening: Promise<MergeViewPanel>): void {
  if (openPanels.get(key) === opening) {
    openPanels.delete(key);
  }
}

/**
 * Registers the history panel, its diff documents and panels, and commands, and the Source Control commands that share
 * its diff tab. `deactivate` runs before subscriptions are disposed, so history cleanup finishes while its log is still
 * open.
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
    vscode.commands.registerCommand(OPEN_HISTORY_COMMAND, () => view.reveal()),
    vscode.commands.registerCommand(REFRESH_HISTORY_COMMAND, () => view.refresh()),
    registerScmChangeCommands(diffPanels, (message) => log.appendLine(message)),
  );
}

/** Drives the `jwDiffer.hasConflicts` context key that shows the editor title button. */
function updateConflictContext(editor: vscode.TextEditor | undefined): void {
  const hasConflicts = editor !== undefined && hasConflictMarkers(editor.document.getText());
  void vscode.commands.executeCommand("setContext", CONTEXT_HAS_CONFLICTS, hasConflicts);
}
