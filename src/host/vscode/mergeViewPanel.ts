import * as vscode from "vscode";
import { ResolutionController } from "../../model/resolutionController";
import type { FocusRequest, WebviewMessage } from "./webviewMessages";
import { HtmlMergeRenderer } from "../../render/html/htmlRenderer";
import type { Resolution } from "../../core/mergeResolver";
import { VscodeMergeDocument } from "./vscodeMergeDocument";

/** Hosts one merge view: owns the webview, and nothing about merging itself. */
export class MergeViewPanel {
  private readonly controller: ResolutionController;
  private readonly disposables: vscode.Disposable[] = [];
  /** Set while this panel is the author of a document change, so it does not
      rebuild the view underneath the caret and then rebuild it again. */
  private isApplyingOwnEdit = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly document: vscode.TextDocument,
    private readonly mediaRoot: vscode.Uri,
    private readonly onDispose: () => void,
  ) {
    this.controller = new ResolutionController(new VscodeMergeDocument(document));

    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    vscode.workspace.onDidChangeTextDocument(
      (event) => this.handleDocumentChange(event),
      undefined,
      this.disposables,
    );

    void this.render();
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

  private async render(focus: FocusRequest | null = null): Promise<void> {
    const settings = vscode.workspace.getConfiguration("differ");
    const model = await this.controller.load({
      wordLevelHighlighting: settings.get<boolean>("wordLevelHighlighting", true),
    });

    if (!model) {
      this.panel.webview.html = renderUnavailable(baseName(this.document.uri));
      return;
    }

    const renderer = new HtmlMergeRenderer({
      styleUri: this.mediaUri("main.css"),
      scriptUri: this.mediaUri("main.js"),
      cspSource: this.panel.webview.cspSource,
    });

    this.panel.webview.html = renderer.render(model, {
      fileName: baseName(this.document.uri),
      showResultPane: settings.get<boolean>("showResultPane", true),
      focus,
    });
  }

  private mediaUri(fileName: string): string {
    return this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, fileName)).toString();
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const isOurDocument = event.document.uri.toString() === this.document.uri.toString();
    if (isOurDocument && !this.isApplyingOwnEdit) {
      void this.render();
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    this.isApplyingOwnEdit = true;
    try {
      await this.dispatch(message);
    } finally {
      this.isApplyingOwnEdit = false;
    }

    await this.render(focusOf(message));
  }

  private async dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "resolve":
        return this.applyResolution(message.conflictIndex, message.resolution);
      case "editLine":
        await this.controller.editLine(message.line, message.text);
        return;
      case "splitLine":
        await this.controller.splitLine(message.line, message.offset);
        return;
      case "joinWithPrevious":
        await this.controller.joinWithPrevious(message.line);
        return;
      case "toggleHunk":
        this.controller.toggleHunk(message.conflictIndex, message.hunkIndex, message.side);
        return;
      case "applySelection":
        return this.applySelection(message.conflictIndex);
    }
  }

  private async applySelection(conflictIndex: number): Promise<void> {
    const outcome = await this.controller.applySelection(conflictIndex);
    if (outcome === "gone") {
      void vscode.window.showWarningMessage("That conflict is no longer present in the file.");
    }
    if (outcome === "failed") {
      void vscode.window.showErrorMessage("Differ could not apply the selected hunks.");
    }
  }

  private async applyResolution(conflictIndex: number, resolution: Resolution): Promise<void> {
    const outcome = await this.controller.resolve(conflictIndex, resolution);
    if (outcome === "gone") {
      void vscode.window.showWarningMessage("That conflict is no longer present in the file.");
    }
    if (outcome === "failed") {
      void vscode.window.showErrorMessage("Differ could not apply the resolution.");
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

function renderUnavailable(fileName: string): string {
  return `<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 2rem;">
<h3>No merge in progress for ${fileName}</h3>
<p>Differ reads the branch and incoming versions from git's conflict stages.
This file has none, so there is nothing to compare against the working copy.</p>
</body></html>`;
}

function baseName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? uri.path;
}

/** Only the editing messages carry a caret to restore; the rest rebuild plainly. */
function focusOf(message: WebviewMessage): FocusRequest | null {
  return "focus" in message ? message.focus : null;
}
