import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Writes a merge result to its file through the file's document, so editors showing it follow; false, once the
 * user is told, when it was not written.
 */
export async function writeMergeResult(uri: vscode.Uri, text: string): Promise<boolean> {
  const name = path.basename(uri.fsPath);
  // The document captured at open may have been closed since; a closed one can no longer be saved.
  const document = await openPresentDocument(uri);
  if (document === null) {
    // "wx" refuses a file, or a link, that appeared since the document failed to open.
    await fs.promises.writeFile(uri.fsPath, text, { flag: "wx" });
    return true;
  }
  // Not atomic with the save: a link put in place in between is followed. Closing that gap would mean writing
  // the file past VS Code, whose editors would then not follow; the check is for a link that appeared while
  // the view was open, not one racing the save.
  if (await isSymbolicLink(document.uri.fsPath)) {
    const reason = "it is a symbolic link, and saving would change the file it points to";
    void vscode.window.showErrorMessage(`Differ will not write ${name}: ${reason}.`);
    return false;
  }
  const edit = new vscode.WorkspaceEdit();
  const wholeDocument = new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
  edit.replace(document.uri, wholeDocument, text);
  const isWritten = (await vscode.workspace.applyEdit(edit)) && (await document.save());
  if (!isWritten) {
    void vscode.window.showErrorMessage(`Differ could not write ${name}.`);
  }
  return isWritten;
}

/** Opens a file's document; null when the file was deleted and no open document holds it, so there is none to open. */
async function openPresentDocument(uri: vscode.Uri): Promise<vscode.TextDocument | null> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    if (await isPresent(uri.fsPath)) {
      throw error;
    }
    return null;
  }
}

async function isPresent(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** A missing file is not a link: saving creates it. */
async function isSymbolicLink(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(filePath)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
