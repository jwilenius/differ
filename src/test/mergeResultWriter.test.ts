import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { writeMergeResult } from "../host/vscode/mergeResultWriter";
import { resetVscodeMock, vscodeMock } from "./vscodeMock";

let directory: string;

/** A file document whose save writes the last applied edit to disk, following symbolic links, or answers `isSaved`. */
function fileDocument(filePath: string, isSaved = true): vscode.TextDocument {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const document = {
    uri: vscode.Uri.file(filePath),
    lineCount: lines.length,
    lineAt: (line: number) => ({ range: new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, lines[line].length)) }),
    save: async (): Promise<boolean> => {
      if (isSaved) {
        fs.writeFileSync(filePath, vscodeMock.appliedEdits.at(-1)?.text ?? "");
      }
      return isSaved;
    },
  };
  return document as unknown as vscode.TextDocument;
}

function failToOpen(): void {
  vscodeMock.openFileDocument = (uri) => {
    throw new Error(`cannot open ${uri.fsPath}`);
  };
}

beforeEach(() => {
  resetVscodeMock();
  vscodeMock.openFileDocument = (uri) => fileDocument(uri.fsPath);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jw-differ-writer-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("writeMergeResult", () => {
  it("replaces the whole document and saves it", async () => {
    const file = path.join(directory, "f.txt");
    fs.writeFileSync(file, "one\ntwo\n");

    const isWritten = await writeMergeResult(vscode.Uri.file(file), "merged\n", false);

    expect(isWritten).toBe(true);
    expect(vscodeMock.appliedEdits).toHaveLength(1);
    expect(vscodeMock.appliedEdits[0].range.start).toEqual(new vscode.Position(0, 0));
    expect(vscodeMock.appliedEdits[0].range.end).toEqual(new vscode.Position(2, 0));
    expect(fs.readFileSync(file, "utf8")).toBe("merged\n");
    expect(vscodeMock.messages).toEqual([]);
  });

  it("starts the text with the byte order mark of a result whose file starts with none", async () => {
    const file = path.join(directory, "f.txt");
    fs.writeFileSync(file, "<<<<<<< HEAD\n");

    await writeMergeResult(vscode.Uri.file(file), "merged\n", true);

    expect(vscodeMock.appliedEdits[0].text).toBe("\ufeffmerged\n");
  });

  it("leaves the byte order mark to the save of a file that starts with one", async () => {
    const file = path.join(directory, "f.txt");
    fs.writeFileSync(file, "\ufeffone\n");

    await writeMergeResult(vscode.Uri.file(file), "merged\n", true);

    expect(vscodeMock.appliedEdits[0].text).toBe("merged\n");
  });

  it("refuses a symbolic link and tells the user", async () => {
    const file = path.join(directory, "f.txt");
    const target = path.join(directory, "target.txt");
    fs.writeFileSync(target, "precious\n");
    fs.symlinkSync(target, file);

    const isWritten = await writeMergeResult(vscode.Uri.file(file), "merged\n", false);

    expect(isWritten).toBe(false);
    expect(vscodeMock.appliedEdits).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe("precious\n");
    expect(vscodeMock.messages).toEqual([{ level: "error", text: "jw-differ will not write f.txt: it is a symbolic link, and saving would change the file it points to." }]);
  });

  it("creates a deleted file that no document can open", async () => {
    const file = path.join(directory, "f.txt");
    failToOpen();

    const isWritten = await writeMergeResult(vscode.Uri.file(file), "merged\n", false);

    expect(isWritten).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("merged\n");
  });

  it("creates a deleted file starting with the byte order mark of a result that has one", async () => {
    const file = path.join(directory, "f.txt");
    failToOpen();

    await writeMergeResult(vscode.Uri.file(file), "merged\n", true);

    expect(fs.readFileSync(file)).toEqual(Buffer.from("\ufeffmerged\n", "utf8"));
  });

  it("passes on the open failure of a file that is present", async () => {
    const file = path.join(directory, "f.txt");
    fs.writeFileSync(file, "one\n");
    failToOpen();

    await expect(writeMergeResult(vscode.Uri.file(file), "merged\n", false)).rejects.toThrow(`cannot open ${file}`);
    expect(fs.readFileSync(file, "utf8")).toBe("one\n");
  });

  it("tells the user when the save fails", async () => {
    const file = path.join(directory, "f.txt");
    fs.writeFileSync(file, "one\n");
    vscodeMock.openFileDocument = (uri) => fileDocument(uri.fsPath, false);

    const isWritten = await writeMergeResult(vscode.Uri.file(file), "merged\n", false);

    expect(isWritten).toBe(false);
    expect(vscodeMock.messages).toEqual([{ level: "error", text: "jw-differ could not write f.txt." }]);
  });
});
