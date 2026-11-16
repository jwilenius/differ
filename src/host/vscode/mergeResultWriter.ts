import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const BYTE_ORDER_MARK = "\uFEFF";
const UTF8_BYTE_ORDER_MARK = Buffer.from(BYTE_ORDER_MARK, "utf8");

/**
 * Writes a merge result to its file through the file's document, so editors showing it follow; false, once the
 * user is told, when it was not written. The file starts with a UTF-8 byte order mark when `hasByteOrderMark`.
 */
export async function writeMergeResult(uri: vscode.Uri, text: string, hasByteOrderMark: boolean): Promise<boolean> {
  const name = path.basename(uri.fsPath);
  // The document captured at open may have been closed since; a closed one can no longer be saved.
  const document = await openPresentDocument(uri);
  if (document === null) {
    // "wx" refuses a file, or a link, that appeared since the document failed to open.
    await fs.promises.writeFile(uri.fsPath, hasByteOrderMark ? BYTE_ORDER_MARK + text : text, { flag: "wx" });
    return true;
  }
  // Not atomic with the save: a link put in place in between is followed. Closing that gap would mean writing
  // the file past VS Code, whose editors would then not follow; the check is for a link that appeared while
  // the view was open, not one racing the save. A missing file is not a link: saving creates it.
  const isSymbolicLink = (await lstatOrNull(document.uri.fsPath))?.isSymbolicLink() ?? false;
  if (isSymbolicLink) {
    const reason = "it is a symbolic link, and saving would change the file it points to";
    void vscode.window.showErrorMessage(`jw-differ will not write ${name}: ${reason}.`);
    return false;
  }
  // VS Code keeps a byte order mark out of the document, writing it back on save, only when the file started with one
  // as it was read; a conflict on the first line leaves the file starting with git's marker instead. In any other
  // document, a mark at the start of the text is saved as it stands.
  const isMarkSaved = await startsWithByteOrderMark(document.uri.fsPath);
  const documentText = hasByteOrderMark && !isMarkSaved ? BYTE_ORDER_MARK + text : text;
  const edit = new vscode.WorkspaceEdit();
  const wholeDocument = new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
  edit.replace(document.uri, wholeDocument, documentText);
  const isWritten = (await vscode.workspace.applyEdit(edit)) && (await document.save());
  if (!isWritten) {
    void vscode.window.showErrorMessage(`jw-differ could not write ${name}.`);
  }
  return isWritten;
}

/** Opens a file's document; null when the file was deleted and no open document holds it, so there is none to open. */
async function openPresentDocument(uri: vscode.Uri): Promise<vscode.TextDocument | null> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    const isPresent = (await lstatOrNull(uri.fsPath)) !== null;
    if (isPresent) {
      throw error;
    }
    return null;
  }
}

/** The file's own status, not that of a link's target; null when it is missing, as a deleted file is. */
async function lstatOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Whether the file starts with a UTF-8 byte order mark; false when it is missing, as a deleted file is. */
async function startsWithByteOrderMark(filePath: string): Promise<boolean> {
  try {
    const content = await fs.promises.readFile(filePath);
    return content.subarray(0, UTF8_BYTE_ORDER_MARK.length).equals(UTF8_BYTE_ORDER_MARK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
