import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { activate } from "../host/vscode/extension";
import { createConflictRepository, divergeBranches, mergeFeature } from "./gitConflictFixture";
import { resetVscodeMock, vscodeMock } from "./vscodeMock";

let repo: string;

/** Activates with an extension folder that has no regex engine; the picker never highlights. */
function activateExtension(): void {
  const folder = os.tmpdir();
  activate({ subscriptions: [], extensionUri: vscode.Uri.file(folder), extensionPath: folder } as unknown as vscode.ExtensionContext);
}

beforeEach(() => {
  resetVscodeMock();
  repo = createConflictRepository();
  vscodeMock.workspaceFolders = [{ uri: vscode.Uri.file(repo), name: "repo", index: 0 }];
  activateExtension();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("Differ: Resolve Conflicts", () => {
  it("offers each conflicted file by name and folder", async () => {
    divergeBranches(repo, ["top.txt", "src/deep.ts"]);
    mergeFeature(repo);

    await vscode.commands.executeCommand("differ.resolveConflicts");

    const [request] = vscodeMock.quickPickRequests;
    const offered = request.items.map(({ label, description }) => ({ label, description }));
    expect(offered).toEqual([{ label: "deep.ts", description: "src" }, { label: "top.txt", description: "" }]);
    expect(request.options.title).toBe("Resolve Conflicts");
  });

  it("reports when nothing is conflicted instead of showing an empty picker", async () => {
    divergeBranches(repo, ["a.txt"]);

    await vscode.commands.executeCommand("differ.resolveConflicts");

    expect(vscodeMock.quickPickRequests).toEqual([]);
    expect(vscodeMock.messages).toEqual([{ level: "information", text: "Differ found no conflicted files." }]);
  });
});
