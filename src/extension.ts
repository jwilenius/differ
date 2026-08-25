import * as vscode from "vscode";
import { hasConflictMarkers } from "./core/conflictParser";
import { MergeViewPanel } from "./view/mergeViewPanel";

const CONTEXT_HAS_CONFLICTS = "differ.hasConflicts";

const openPanels = new Map<string, MergeViewPanel>();

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
}

export function deactivate(): void {
  openPanels.clear();
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

/** Drives the `differ.hasConflicts` context key that shows the editor title button. */
function updateConflictContext(editor: vscode.TextEditor | undefined): void {
  const hasConflicts = editor !== undefined && hasConflictMarkers(editor.document.getText());
  void vscode.commands.executeCommand("setContext", CONTEXT_HAS_CONFLICTS, hasConflicts);
}
