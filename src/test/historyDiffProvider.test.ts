import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  HISTORY_DOCUMENT_SCHEME,
  HistoryDiffProvider,
  UNAVAILABLE_DOCUMENT_TEXT,
} from "../host/vscode/historyDiffProvider";
import type {
  ComparisonFile,
  FileContentResult,
  FileSide,
  HistoryRepository,
  ReadyResult,
} from "../model/historyTypes";
import type { TwoWayDiffRequest } from "../host/vscode/twoWayDiffPanel";
import { fireDidCloseTextDocument, resetVscodeMock, vscodeMock } from "./vscodeMock";

const BASE_OID = "a".repeat(40);
const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";

type Contents = Readonly<Record<FileSide, FileContentResult>>;

function text(value: string): FileContentResult {
  return { kind: "text", text: value };
}

/** A port whose `readFile` serves fixed contents and records every read. */
function fakeRepository(contents: Contents): HistoryRepository & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    loadHistory: () => Promise.reject(new Error("unused")),
    resolveRef: () => Promise.reject(new Error("unused")),
    compare: () => Promise.reject(new Error("unused")),
    readFile: (snapshotId, fileId, side) => {
      reads.push(`${snapshotId}/${fileId}/${side}`);
      return Promise.resolve(contents[side]);
    },
    releaseSnapshot: () => undefined,
  };
}

function file(changes: Partial<ComparisonFile> = {}): ComparisonFile {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    status: "modified",
    base: { path: "src/app.ts", blob: "b".repeat(40), mode: "100644" },
    result: { path: "src/app.ts", blob: "c".repeat(40), mode: "100644" },
    contentKind: "text",
    ...changes,
  };
}

function comparison(changes: Partial<ReadyResult> = {}): ReadyResult {
  return {
    kind: "ready",
    snapshotId: SNAPSHOT_ID,
    base: { kind: "commit", oid: BASE_OID, subject: "base" },
    orderedOids: ["d".repeat(40), "e".repeat(40)],
    files: [],
    ...changes,
  };
}

function lastCommand(): { readonly command: string; readonly args: readonly unknown[] } {
  return vscodeMock.executedCommands[vscodeMock.executedCommands.length - 1];
}

function documentFor(uri: vscode.Uri): vscode.TextDocument {
  return { uri } as vscode.TextDocument;
}

/** Records panel requests instead of opening webviews. */
function fakePanels(): { open(request: TwoWayDiffRequest): Promise<void>; requests: TwoWayDiffRequest[] } {
  const requests: TwoWayDiffRequest[] = [];
  return {
    requests,
    open: (request) => {
      requests.push(request);
      return Promise.resolve();
    },
  };
}

describe("HistoryDiffProvider with the native viewer", () => {
  let provider: HistoryDiffProvider;
  let panels: ReturnType<typeof fakePanels>;

  beforeEach(() => {
    resetVscodeMock();
    vscodeMock.configuration.set("differ.historyDiffViewer", "native");
    panels = fakePanels();
    provider = new HistoryDiffProvider(panels);
  });

  it("opens the native diff with both sides of the requested snapshot", async () => {
    const repository = fakeRepository({ base: text("old\n"), result: text("new\n") });

    await provider.openFile(repository, comparison(), file());

    const { command, args } = lastCommand();
    const [left, right, title, options] = args as [vscode.Uri, vscode.Uri, string, unknown];
    expect(command).toBe("vscode.diff");
    expect(title).toBe("src/app.ts (aaaaaaaa ↔ 2 selected commits)");
    expect(options).toEqual({ preview: true });
    expect(left.scheme).toBe(HISTORY_DOCUMENT_SCHEME);
    expect(provider.provideTextDocumentContent(left)).toBe("old\n");
    expect(provider.provideTextDocumentContent(right)).toBe("new\n");
    expect(repository.reads).toEqual([`${SNAPSHOT_ID}/${file().id}/base`, `${SNAPSHOT_ID}/${file().id}/result`]);
  });

  it("starts both reads before either completes", async () => {
    const repository = fakeRepository({ base: text(""), result: text("") });
    const pending = provider.openFile(repository, comparison(), file());

    expect(repository.reads).toHaveLength(2);
    await pending;
  });

  it("labels renames with old and new paths and an empty-tree base", async () => {
    const renamed = file({
      status: "renamed",
      base: { path: "old/name.ts", blob: "b".repeat(40), mode: "100644" },
      result: { path: "new/name.ts", blob: "c".repeat(40), mode: "100644" },
    });

    await provider.openFile(fakeRepository({ base: text("a"), result: text("a") }), comparison({
      base: { kind: "emptyTree" },
      orderedOids: ["d".repeat(40)],
    }), renamed);

    const [left, right, title] = lastCommand().args as [vscode.Uri, vscode.Uri, string];
    expect(title).toBe("old/name.ts → new/name.ts (empty tree ↔ 1 selected commit)");
    expect(left.path.endsWith("/old/name.ts")).toBe(true);
    expect(right.path.endsWith("/new/name.ts")).toBe(true);
  });

  it("uses the result path and empty text for an added file's missing base", async () => {
    const added = file({ status: "added", base: null });

    await provider.openFile(fakeRepository({ base: text(""), result: text("hello\n") }), comparison(), added);

    const [left, right] = lastCommand().args as [vscode.Uri, vscode.Uri];
    expect(left.path.endsWith("/src/app.ts")).toBe(true);
    expect(provider.provideTextDocumentContent(left)).toBe("");
    expect(provider.provideTextDocumentContent(right)).toBe("hello\n");
  });

  it("keeps already opened content when a later comparison of the same file opens", async () => {
    await provider.openFile(fakeRepository({ base: text("v1"), result: text("v2") }), comparison(), file());
    const [firstLeft, firstRight] = lastCommand().args as [vscode.Uri, vscode.Uri];

    await provider.openFile(
      fakeRepository({ base: text("other"), result: text("content") }),
      comparison({ snapshotId: "33333333-3333-4333-8333-333333333333" }),
      file(),
    );
    const [secondLeft] = lastCommand().args as [vscode.Uri];

    expect(secondLeft.toString()).not.toBe(firstLeft.toString());
    expect(provider.provideTextDocumentContent(firstLeft)).toBe("v1");
    expect(provider.provideTextDocumentContent(firstRight)).toBe("v2");
  });

  it("keeps hostile paths as URI path data", async () => {
    const hostile = "../../etc/passwd?x=1#frag %2e\n";
    const changed = file({
      base: { path: hostile, blob: "b".repeat(40), mode: "100644" },
      result: { path: hostile, blob: "c".repeat(40), mode: "100644" },
    });

    await provider.openFile(fakeRepository({ base: text("a"), result: text("b") }), comparison(), changed);

    const [left] = lastCommand().args as [vscode.Uri];
    const roundTripped = vscode.Uri.parse(left.toString());
    expect(roundTripped.scheme).toBe(HISTORY_DOCUMENT_SCHEME);
    expect(roundTripped.path).toBe(left.path);
    expect(roundTripped.query).toBe("");
    expect(roundTripped.fragment).toBe("");
    expect(provider.provideTextDocumentContent(roundTripped)).toBe("a");
  });

  it("serves nothing for URIs it did not issue", () => {
    const unknown = vscode.Uri.from({ scheme: HISTORY_DOCUMENT_SCHEME, path: "/etc/passwd" });
    const otherScheme = vscode.Uri.file("/etc/passwd");

    expect(provider.provideTextDocumentContent(unknown)).toBe(UNAVAILABLE_DOCUMENT_TEXT);
    expect(provider.provideTextDocumentContent(otherScheme)).toBe(UNAVAILABLE_DOCUMENT_TEXT);
  });

  it("opens an explanation instead of decoding binary content", async () => {
    const binary: FileContentResult = {
      kind: "nonText",
      reason: "binary",
      explanation: "Binary content is not shown.",
      sizeBytes: 2048,
      mode: "100644",
    };
    const image = file({
      status: "added",
      base: null,
      result: { path: "logo.png", blob: "c".repeat(40), mode: "100644" },
      contentKind: "binary",
    });

    await provider.openFile(fakeRepository({ base: text(""), result: binary }), comparison(), image);

    const { command, args } = lastCommand();
    const [uri] = args as [vscode.Uri];
    const explanation = provider.provideTextDocumentContent(uri);
    expect(command).toBe("vscode.open");
    expect(panels.requests).toEqual([]);
    expect(explanation).toContain("logo.png ");
    expect(explanation).toContain("Base:   absent");
    expect(explanation).toContain("binary, 2048 bytes");
    expect(explanation).toContain("mode 100644");
    expect(explanation).toContain("aaaaaaaa ↔ 2 selected commits");
  });

  it("forgets content when its document closes", async () => {
    await provider.openFile(fakeRepository({ base: text("old"), result: text("new") }), comparison(), file());
    const [left, right] = lastCommand().args as [vscode.Uri, vscode.Uri];

    fireDidCloseTextDocument(documentFor(left));

    expect(provider.provideTextDocumentContent(left)).toBe(UNAVAILABLE_DOCUMENT_TEXT);
    expect(provider.provideTextDocumentContent(right)).toBe("new");
  });

  it("forgets content when opening the editor fails", async () => {
    let opened: vscode.Uri[] = [];
    vscode.commands.registerCommand("vscode.diff", (left, right) => {
      opened = [left as vscode.Uri, right as vscode.Uri];
      throw new Error("editor failed");
    });

    const result = provider.openFile(fakeRepository({ base: text("old"), result: text("new") }), comparison(), file());

    await expect(result).rejects.toThrow("editor failed");
    expect(opened.map((uri) => provider.provideTextDocumentContent(uri))).toEqual([
      UNAVAILABLE_DOCUMENT_TEXT,
      UNAVAILABLE_DOCUMENT_TEXT,
    ]);
  });

  it("opens nothing when the snapshot has already been released", async () => {
    const repository = fakeRepository({ base: text(""), result: text("") });
    repository.readFile = vi.fn(() => Promise.reject(new Error("This comparison is no longer available.")));

    await expect(provider.openFile(repository, comparison(), file())).rejects.toThrow("no longer available");
    expect(vscodeMock.executedCommands).toEqual([]);
  });

  it("clears its cache and stops listening on dispose", async () => {
    await provider.openFile(fakeRepository({ base: text("old"), result: text("new") }), comparison(), file());
    const [left] = lastCommand().args as [vscode.Uri];

    provider.dispose();

    expect(provider.provideTextDocumentContent(left)).toBe(UNAVAILABLE_DOCUMENT_TEXT);
  });
});

describe("HistoryDiffProvider with the IntelliJ viewer", () => {
  let provider: HistoryDiffProvider;
  let panels: ReturnType<typeof fakePanels>;

  beforeEach(() => {
    resetVscodeMock();
    panels = fakePanels();
    provider = new HistoryDiffProvider(panels);
  });

  async function openPanel(changes: Partial<ComparisonFile> = {}): Promise<TwoWayDiffRequest> {
    await provider.openFile(fakeRepository({ base: text("old\n"), result: text("new\n") }), comparison(), file(changes));
    return panels.requests[panels.requests.length - 1];
  }

  it("opens text files in the diff panel by default", async () => {
    const request = await openPanel();

    expect(vscodeMock.executedCommands).toEqual([]);
    expect(request.title).toBe("src/app.ts (aaaaaaaa ↔ 2 selected commits)");
    expect(request.base).toMatchObject({ text: "old\n", label: "aaaaaaaa", path: "src/app.ts" });
    expect(request.result).toMatchObject({ text: "new\n", label: "2 selected commits", path: "src/app.ts" });
    expect(provider.provideTextDocumentContent(request.base.uri)).toBe("old\n");
    expect(request.languageUri).toBe(request.result.uri);
  });

  it("takes the language from the base document of a deleted file", async () => {
    const request = await openPanel({ status: "deleted", result: null });

    expect(request.languageUri).toBe(request.base.uri);
    expect(request.result.path).toBe("");
  });

  it("opens the same cached documents in the native diff on request", async () => {
    const request = await openPanel();

    await request.openNative();

    const [left, right, title, options] = lastCommand().args as [vscode.Uri, vscode.Uri, string, unknown];
    expect(lastCommand().command).toBe("vscode.diff");
    expect([left, right]).toEqual([request.base.uri, request.result.uri]);
    expect(title).toBe(request.title);
    expect(options).toEqual({ preview: true });
  });

  it("keeps documents an open panel shows after VS Code closes them", async () => {
    const request = await openPanel();

    fireDidCloseTextDocument(documentFor(request.base.uri));

    expect(provider.provideTextDocumentContent(request.base.uri)).toBe("old\n");
  });

  it("forgets documents when the panel closes unless VS Code still has them open", async () => {
    const request = await openPanel();
    const resultDocument = await vscode.workspace.openTextDocument(request.result.uri);

    request.release();

    expect(provider.provideTextDocumentContent(request.base.uri)).toBe(UNAVAILABLE_DOCUMENT_TEXT);
    expect(provider.provideTextDocumentContent(request.result.uri)).toBe("new\n");
    fireDidCloseTextDocument(resultDocument);
    expect(provider.provideTextDocumentContent(request.result.uri)).toBe(UNAVAILABLE_DOCUMENT_TEXT);
  });

  it("forgets both documents when the panel cannot open", async () => {
    panels.open = (request) => {
      panels.requests.push(request);
      return Promise.reject(new Error("panel failed"));
    };

    await expect(provider.openFile(fakeRepository({ base: text("a"), result: text("b") }), comparison(), file())).rejects.toThrow("panel failed");

    const [request] = panels.requests;
    expect(provider.provideTextDocumentContent(request.base.uri)).toBe(UNAVAILABLE_DOCUMENT_TEXT);
    expect(provider.provideTextDocumentContent(request.result.uri)).toBe(UNAVAILABLE_DOCUMENT_TEXT);
  });
});
