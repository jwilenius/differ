import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  OPEN_STAGED_CHANGE_COMMAND,
  OPEN_WORKING_TREE_CHANGE_COMMAND,
  registerScmChangeCommands,
} from "../host/vscode/scmChangeCommands";
import type { TwoWayDiffRequest } from "../host/vscode/twoWayDiffPanel";
import { createConflictRepository, runGit } from "./gitConflictFixture";
import { resetVscodeMock, vscodeMock } from "./vscodeMock";

interface MenuEntry {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
}

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { readonly command: string; readonly icon?: unknown }[];
    readonly menus: Readonly<Record<string, readonly MenuEntry[]>>;
  };
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as Manifest;
const WORKING_TREE_GROUPS = "scmProvider == git && (scmResourceGroup == workingTree || scmResourceGroup == untracked)";

let root: string;
let requests: TwoWayDiffRequest[];
let registration: vscode.Disposable;

beforeEach(() => {
  resetVscodeMock();
  root = createConflictRepository();
  requests = [];
  registration = registerScmChangeCommands({ open: async (request) => void requests.push(request) }, () => undefined);
});

afterEach(() => {
  registration.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function commit(name: string, content: string): vscode.Uri {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  runGit(root, "add", "--", name);
  runGit(root, "commit", "-qm", `commit ${name}`);
  return vscode.Uri.file(file);
}

/** A Source Control row, as the Git extension passes it to a menu command. */
function resourceState(uri: vscode.Uri): vscode.SourceControlResourceState {
  return { resourceUri: uri };
}

/** What the request shows: its title and each side's label, path and text. */
function shown(request: TwoWayDiffRequest | undefined): unknown {
  return request && {
    title: request.title,
    base: [request.base.label, request.base.path, request.base.text],
    result: [request.result.label, request.result.path, request.result.text],
  };
}

describe("Source Control menus", () => {
  const entries = manifest.contributes.menus["scm/resourceState/context"] ?? [];

  it.each([
    [OPEN_WORKING_TREE_CHANGE_COMMAND, WORKING_TREE_GROUPS],
    [OPEN_STAGED_CHANGE_COMMAND, "scmProvider == git && scmResourceGroup == index"],
  ])("show %s as a row icon and in the context menu of its group", (command, when) => {
    expect(entries.filter((entry) => entry.command === command)).toEqual([
      { command, when, group: "inline" },
      { command, when, group: "navigation" },
    ]);
  });

  it("gives every row command an icon", () => {
    const inlineCommands = entries.filter((entry) => entry.group === "inline").map((entry) => entry.command);
    const commandsWithIcons = manifest.contributes.commands
      .filter((command) => command.icon !== undefined)
      .map((command) => command.command);

    expect(commandsWithIcons).toEqual(expect.arrayContaining(inlineCommands));
  });

  it("offers only the working-tree change in the Command Palette, for the active file", () => {
    const palette = manifest.contributes.menus["commandPalette"] ?? [];

    expect(palette).toEqual(expect.arrayContaining([
      { command: OPEN_WORKING_TREE_CHANGE_COMMAND, when: "resourceScheme == file" },
      { command: OPEN_STAGED_CHANGE_COMMAND, when: "false" },
    ]));
  });
});

describe(OPEN_WORKING_TREE_CHANGE_COMMAND, () => {
  it("opens the index against the working tree, with F4 opening the file", async () => {
    const uri = commit("src/a.ts", "one\n");
    fs.writeFileSync(uri.fsPath, "two\n");

    await vscode.commands.executeCommand(OPEN_WORKING_TREE_CHANGE_COMMAND, resourceState(uri));

    expect(shown(requests[0])).toEqual({
      title: "src/a.ts (Index ↔ Working Tree)",
      base: ["Index", "src/a.ts", "one\n"],
      result: ["Working Tree", "src/a.ts", "two\n"],
    });
    expect(requests[0]?.languageUri.fsPath).toBe(uri.fsPath);
    expect(requests[0]?.workingCopy?.fsPath).toBe(uri.fsPath);
  });

  it("opens only the first of several selected changes", async () => {
    const first = commit("a.txt", "a\n");
    const second = commit("b.txt", "b\n");

    await vscode.commands.executeCommand(OPEN_WORKING_TREE_CHANGE_COMMAND, resourceState(first), resourceState(second));

    expect(requests.map((request) => request.title)).toEqual(["a.txt (Index ↔ Working Tree)"]);
  });

  it("opens only the latest of overlapping requests, whichever read finishes first", async () => {
    const first = commit("a.txt", "a\n");
    const second = commit("b.txt", "b\n");

    await Promise.all([
      vscode.commands.executeCommand(OPEN_WORKING_TREE_CHANGE_COMMAND, resourceState(first)),
      vscode.commands.executeCommand(OPEN_STAGED_CHANGE_COMMAND, resourceState(second)),
    ]);

    expect(requests.map((request) => request.title)).toEqual(["b.txt (HEAD ↔ Index)"]);
  });

  it("shows an open file's unsaved edits", async () => {
    const uri = commit("a.txt", "saved\n");
    vscodeMock.textDocuments.push({ uri, isDirty: true, getText: () => "unsaved\n" } as unknown as vscode.TextDocument);

    await vscode.commands.executeCommand(OPEN_WORKING_TREE_CHANGE_COMMAND, resourceState(uri));

    expect(shown(requests[0])).toMatchObject({ result: ["Working Tree", "a.txt", "unsaved\n"] });
  });

  it.each<[NodeJS.Platform, string]>([
    ["win32", "unsaved\n"],
    ["darwin", "unsaved\n"],
    ["linux", "saved\n"],
  ])("on %s, matches unsaved edits to a file named with other casing, showing %j", async (platform, text) => {
    const uri = commit("a.txt", "saved\n");
    const editorUri = vscode.Uri.file(uri.fsPath.toUpperCase());
    const document = { uri: editorUri, isDirty: true, getText: () => "unsaved\n" };
    vscodeMock.textDocuments.push(document as unknown as vscode.TextDocument);
    registration.dispose();
    registration = registerScmChangeCommands(
      { open: async (request) => void requests.push(request) },
      () => undefined,
      platform,
    );

    await vscode.commands.executeCommand(OPEN_WORKING_TREE_CHANGE_COMMAND, resourceState(uri));

    expect(shown(requests[0])).toMatchObject({ result: ["Working Tree", "a.txt", text] });
  });

  it("opens the active editor's file when run from the Command Palette", async () => {
    const uri = commit("a.txt", "one\n");
    fs.writeFileSync(uri.fsPath, "two\n");
    vscodeMock.activeTextEditor = { document: { uri } } as unknown as vscode.TextEditor;

    await vscode.commands.executeCommand(OPEN_WORKING_TREE_CHANGE_COMMAND);

    expect(shown(requests[0])).toMatchObject({ base: ["Index", "a.txt", "one\n"] });
  });

  it("asks for a file when run without one", async () => {
    await vscode.commands.executeCommand(OPEN_WORKING_TREE_CHANGE_COMMAND);

    expect(requests).toEqual([]);
    expect(vscodeMock.messages.map((message) => message.text)).toEqual(["Open a file to see its changes in jw-differ."]);
  });

  it("leaves a deleted file without a working copy for F4", async () => {
    const uri = commit("a.txt", "gone\n");
    fs.rmSync(uri.fsPath);

    await vscode.commands.executeCommand(OPEN_WORKING_TREE_CHANGE_COMMAND, resourceState(uri));

    expect(shown(requests[0])).toEqual({
      title: "a.txt (Index ↔ Working Tree)",
      base: ["Index", "a.txt", "gone\n"],
      result: ["Working Tree", "", ""],
    });
    expect(requests[0]?.workingCopy).toBeUndefined();
  });

  it("opens VS Code's diff for a binary change", async () => {
    const uri = commit("a.bin", "text\n");
    fs.writeFileSync(uri.fsPath, Buffer.from([0x00, 0x01]));
    const state = resourceState(uri);

    await vscode.commands.executeCommand(OPEN_WORKING_TREE_CHANGE_COMMAND, state);

    expect(requests).toEqual([]);
    expect(vscodeMock.messages.map((message) => message.text)).toEqual(["a.bin is binary, so VS Code's diff shows it."]);
    expect(vscodeMock.executedCommands.at(-1)).toEqual({ command: "git.openChange", args: [state] });
  });

  it("reports a file outside any repository", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jw-differ-outside-"));
    const uri = vscode.Uri.file(path.join(outside, "a.txt"));
    fs.writeFileSync(uri.fsPath, "text\n");

    try {
      await vscode.commands.executeCommand(OPEN_WORKING_TREE_CHANGE_COMMAND, uri);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }

    expect(requests).toEqual([]);
    expect(vscodeMock.messages.map((message) => message.level)).toEqual(["error"]);
  });
});

describe(OPEN_STAGED_CHANGE_COMMAND, () => {
  it("opens HEAD against the index, naming both paths of a rename", async () => {
    commit("old.txt", "kept\nlines\nhere\n");
    runGit(root, "mv", "old.txt", "new.txt");
    const uri = vscode.Uri.file(path.join(root, "new.txt"));
    const state = resourceState(uri);

    await vscode.commands.executeCommand(OPEN_STAGED_CHANGE_COMMAND, state);
    await requests[0]?.openNative();

    expect(shown(requests[0])).toEqual({
      title: "old.txt → new.txt (HEAD ↔ Index)",
      base: ["HEAD", "old.txt", "kept\nlines\nhere\n"],
      result: ["Index", "new.txt", "kept\nlines\nhere\n"],
    });
    expect(vscodeMock.executedCommands.at(-1)).toEqual({ command: "git.openChange", args: [state] });
  });
});
