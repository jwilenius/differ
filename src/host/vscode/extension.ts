import * as path from "node:path";
import * as vscode from "vscode";
import { hasConflictMarkers } from "../../core/conflictParser";
import { HISTORY_DOCUMENT_SCHEME, HistoryDiffProvider } from "./historyDiffProvider";
import { HISTORY_VIEW_ID, HistoryViewProvider, OPEN_HISTORY_COMMAND } from "./historyViewProvider";
import { MergeViewPanel } from "./mergeViewPanel";
import { SyntaxHighlighting } from "./syntaxHighlighting";
import { TwoWayDiffPanels } from "./twoWayDiffPanel";

const CONTEXT_HAS_CONFLICTS = "differ.hasConflicts";
const REFRESH_HISTORY_COMMAND = "differ.refreshHistory";
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

/** Shows the merge view of `document`, reusing an open one. */
async function openMergeView(document: vscode.TextDocument, services: Services): Promise<void> {
  const key = document.uri.toString();
  const existing = openPanels.get(key);
  if (existing) {
    (await existing).reveal();
    return;
  }
  const opening = MergeViewPanel.create({
    document,
    mediaRoot: services.mediaRoot,
    highlighter: services.highlighter,
    log: (message) => services.log.appendLine(message),
    onDispose: () => openPanels.delete(key),
  });
  openPanels.set(key, opening);
  try {
    await opening;
  } catch (error) {
    openPanels.delete(key);
    services.log.appendLine(`Opening the merge view of ${document.uri.fsPath} failed. ${error instanceof Error ? error.message : String(error)}`);
    void vscode.window.showErrorMessage("Differ could not open the merge view.");
  }
}

/**
 * Registers the history panel, its diff documents and panels, and commands. `deactivate` runs before subscriptions are disposed,
 * so history cleanup finishes while its log is still open.
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
  );
}

/** Drives the `differ.hasConflicts` context key that shows the editor title button. */
function updateConflictContext(editor: vscode.TextEditor | undefined): void {
  const hasConflicts = editor !== undefined && hasConflictMarkers(editor.document.getText());
  void vscode.commands.executeCommand("setContext", CONTEXT_HAS_CONFLICTS, hasConflicts);
}
