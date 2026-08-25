import * as vscode from "vscode";
import { parseConflicts } from "../core/conflictParser";
import { resolvedLines, type Resolution } from "../core/mergeResolver";
import type { ConflictSection } from "../core/types";
import { renderMergePage } from "./webviewHtml";
import { buildMergeView } from "./viewModel";

interface ResolveMessage {
  readonly type: "resolve";
  readonly conflictIndex: number;
  readonly resolution: Resolution;
}

/** One three-way merge webview bound to a single document. */
export class MergeViewPanel {
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly document: vscode.TextDocument,
    private readonly mediaRoot: vscode.Uri,
    private readonly onDispose: () => void,
  ) {
    this.panel.webview.onDidReceiveMessage(
      (message: ResolveMessage) => this.handleMessage(message),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    vscode.workspace.onDidChangeTextDocument(
      (event) => this.handleDocumentChange(event),
      undefined,
      this.disposables,
    );

    this.render();
  }

  static create(document: vscode.TextDocument, mediaRoot: vscode.Uri, onDispose: () => void): MergeViewPanel {
    const panel = vscode.window.createWebviewPanel(
      "differ.mergeView",
      `Merge: ${baseName(document.uri)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] },
    );

    return new MergeViewPanel(panel, document, mediaRoot, onDispose);
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  private render(): void {
    const settings = vscode.workspace.getConfiguration("differ");
    const model = buildMergeView(this.document.getText(), {
      wordLevelHighlighting: settings.get<boolean>("wordLevelHighlighting", true),
    });

    const webview = this.panel.webview;
    this.panel.webview.html = renderMergePage(model, {
      fileName: baseName(this.document.uri),
      showBasePane: settings.get<boolean>("showBasePane", true),
      styleUri: this.mediaUri(webview, "main.css"),
      scriptUri: this.mediaUri(webview, "main.js"),
      cspSource: webview.cspSource,
    });
  }

  private mediaUri(webview: vscode.Webview, fileName: string): string {
    return webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, fileName)).toString();
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (event.document.uri.toString() !== this.document.uri.toString()) {
      return;
    }
    this.render();
  }

  private async handleMessage(message: ResolveMessage): Promise<void> {
    if (message.type !== "resolve") {
      return;
    }

    const conflict = conflictAt(this.document.getText(), message.conflictIndex);
    if (!conflict) {
      void vscode.window.showWarningMessage("That conflict is no longer present in the file.");
      this.render();
      return;
    }

    await this.applyResolution(conflict, message.resolution);
  }

  private async applyResolution(conflict: ConflictSection, resolution: Resolution): Promise<void> {
    const lastMarkerLine = this.document.lineAt(conflict.markerEndLine);
    const range = new vscode.Range(
      new vscode.Position(conflict.markerStartLine, 0),
      lastMarkerLine.range.end,
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, range, resolvedLines(conflict, resolution).join("\n"));

    // A successful edit re-renders through onDidChangeTextDocument.
    const isApplied = await vscode.workspace.applyEdit(edit);
    if (!isApplied) {
      void vscode.window.showErrorMessage("Differ could not apply the resolution.");
      this.render();
    }
  }

  private dispose(): void {
    this.onDispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

/** Finds the nth conflict in the current text, or `null` if it has been resolved away. */
function conflictAt(text: string, index: number): ConflictSection | null {
  const conflicts = parseConflicts(text).filter(
    (section): section is ConflictSection => section.kind === "conflict",
  );
  return conflicts[index] ?? null;
}

function baseName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? uri.path;
}
