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

const openPanels = new Map<string, MergeViewPanel>();
/** Kept so `deactivate` can wait for history cleanup; VS Code does not await subscription disposal. */
let historyView: HistoryViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");

  context.subscriptions.push(
    vscode.commands.registerCommand("differ.openMergeView", () => openMergeView(mediaRoot)),
    vscode.window.onDidChangeActiveTextEditor(updateConflictContext),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        updateConflictContext(vscode.window.activeTextEditor);
      }
    }),
  );

  updateConflictContext(vscode.window.activeTextEditor);
  activateHistory(context, mediaRoot);
}

export async function deactivate(): Promise<void> {
  openPanels.clear();
  await historyView?.dispose();
  historyView = undefined;
}

function openMergeView(mediaRoot: vscode.Uri): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a conflicted file first.");
    return;
  }

  const document = editor.document;
  if (!hasConflictMarkers(document.getText())) {
    void vscode.window.showInformationMessage("Differ found no conflict markers in this file.");
    return;
  }

  const key = document.uri.toString();
  const existing = openPanels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }

  openPanels.set(key, MergeViewPanel.create(document, mediaRoot, () => openPanels.delete(key)));
}

/**
 * Registers the history panel, its diff documents and panels, and commands. `deactivate` runs before subscriptions are disposed,
 * so history cleanup finishes while its log is still open.
 */
function activateHistory(context: vscode.ExtensionContext, mediaRoot: vscode.Uri): void {
  const log = vscode.window.createOutputChannel(HISTORY_OUTPUT_CHANNEL);
  const appendLog = (message: string): void => log.appendLine(message);
  const highlighter = new SyntaxHighlighting(path.join(context.extensionPath, "dist", "onig.wasm"), appendLog);
  const diffPanels = new TwoWayDiffPanels({ mediaRoot, highlighter, log: appendLog });
  const diffProvider = new HistoryDiffProvider(diffPanels);
  const view = new HistoryViewProvider({ mediaRoot, fileOpener: diffProvider, log });
  historyView = view;

  context.subscriptions.push(
    view,
    diffPanels,
    diffProvider,
    highlighter,
    log,
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
