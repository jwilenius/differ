import * as vscode from "vscode";
import type { MergeDocument } from "../../model/mergeDocument";

/** Adapts a VS Code text document to the model's editable-document port. */
export class VscodeMergeDocument implements MergeDocument {
  constructor(private readonly document: vscode.TextDocument) {}

  get filePath(): string {
    return this.document.uri.fsPath;
  }

  getText(): string {
    return this.document.getText();
  }

  async replaceLines(
    startLine: number,
    endLine: number,
    replacement: readonly string[],
  ): Promise<boolean> {
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      this.document.lineAt(endLine).range.end,
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, range, replacement.join("\n"));

    return vscode.workspace.applyEdit(edit);
  }
}
