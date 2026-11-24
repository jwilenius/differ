import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  COMPARISON_CHANGED_MESSAGE,
  HISTORY_DOCUMENT_SCHEME,
  type HistoryCheckout,
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
import { HistorySnapshotError } from "../git/gitComparisonRepository";
import type { AdjacentFiles, TwoWayDiffRequest } from "../host/vscode/twoWayDiffPanel";
import { fireDidCloseTextDocument, resetVscodeMock, vscodeMock } from "./vscodeMock";

const BASE_OID = "a".repeat(40);
const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const ROOT = "/work/project";

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
    readWorkingChanges: () => Promise.reject(new Error("unused")),
    resolveRef: () => Promise.reject(new Error("unused")),
    compare: () => Promise.reject(new Error("unused")),
    readFile: (snapshotId, fileId, side) => {
      reads.push(`${snapshotId}/${fileId}/${side}`);
      return Promise.resolve(contents[side]);
    },
    hasSnapshot: () => true,
    releaseSnapshot: () => undefined,
  };
}

function checkout(repository: HistoryRepository): HistoryCheckout {
  return { repository, root: ROOT };
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
    isIncomplete: false,
    ...changes,
  };
}

function lastCommand(): { readonly command: string; readonly args: readonly unknown[] } {
  return vscodeMock.executedCommands[vscodeMock.executedCommands.length - 1];
}

function documentFor(uri: vscode.Uri): vscode.TextDocument {
  return { uri } as vscode.TextDocument;
}

/** Lets pending promise callbacks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FakePanels {
  open(request: TwoWayDiffRequest): Promise<void>;
  readonly requests: TwoWayDiffRequest[];
  /**
   * What each request's `findAdjacentFiles` found, started as the panel shows it and stopped once the next request
   * replaces it, as the real panel does.
   */
  readonly neighbours: Map<TwoWayDiffRequest, Promise<AdjacentFiles>>;
}

/** Records panel requests instead of opening webviews. */
function fakePanels(): FakePanels {
  const requests: TwoWayDiffRequest[] = [];
  const neighbours = new Map<TwoWayDiffRequest, Promise<AdjacentFiles>>();
  let finding = new AbortController();
  return {
    requests,
    neighbours,
    open: (request) => {
      requests.push(request);
      finding.abort();
      finding = new AbortController();
      if (request.findAdjacentFiles !== undefined) {
        neighbours.set(request, request.findAdjacentFiles(finding.signal));
      }
      return Promise.resolve();
    },
  };
}

describe("HistoryDiffProvider with the native viewer", () => {
  let provider: HistoryDiffProvider;
  let panels: ReturnType<typeof fakePanels>;

  beforeEach(() => {
    resetVscodeMock();
    vscodeMock.configuration.set("jwDiffer.historyDiffViewer", "native");
    panels = fakePanels();
    provider = new HistoryDiffProvider(panels, () => undefined);
  });

  it("opens the native diff with both sides of the requested snapshot", async () => {
    const repository = fakeRepository({ base: text("old\n"), result: text("new\n") });

    await provider.openFile(checkout(repository), comparison(), file());

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
    const pending = provider.openFile(checkout(repository), comparison(), file());

    expect(repository.reads).toHaveLength(2);
    await pending;
  });

  it("labels renames with old and new paths and an empty-tree base", async () => {
    const renamed = file({
      status: "renamed",
      base: { path: "old/name.ts", blob: "b".repeat(40), mode: "100644" },
      result: { path: "new/name.ts", blob: "c".repeat(40), mode: "100644" },
    });

    await provider.openFile(checkout(fakeRepository({ base: text("a"), result: text("a") })), comparison({
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

    await provider.openFile(checkout(fakeRepository({ base: text(""), result: text("hello\n") })), comparison(), added);

    const [left, right] = lastCommand().args as [vscode.Uri, vscode.Uri];
    expect(left.path.endsWith("/src/app.ts")).toBe(true);
    expect(provider.provideTextDocumentContent(left)).toBe("");
    expect(provider.provideTextDocumentContent(right)).toBe("hello\n");
  });

  it("keeps already opened content when a later comparison of the same file opens", async () => {
    await provider.openFile(checkout(fakeRepository({ base: text("v1"), result: text("v2") })), comparison(), file());
    const [firstLeft, firstRight] = lastCommand().args as [vscode.Uri, vscode.Uri];

    await provider.openFile(
      checkout(fakeRepository({ base: text("other"), result: text("content") })),
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

    await provider.openFile(checkout(fakeRepository({ base: text("a"), result: text("b") })), comparison(), changed);

    const [left] = lastCommand().args as [vscode.Uri];
    const roundTripped = vscode.Uri.parse(left.toString());
    expect(roundTripped.scheme).toBe(HISTORY_DOCUMENT_SCHEME);
    expect(roundTripped.path).toBe(left.path);
    expect(roundTripped.query).toBe("");
    expect(roundTripped.fragment).toBe("");
    expect(provider.provideTextDocumentContent(roundTripped)).toBe("a");
  });

  it("reports no file shown in jw-differ's panel for a native diff", async () => {
    await provider.openFile(checkout(fakeRepository({ base: text("old\n"), result: text("new\n") })), comparison(), file());

    expect(provider.openedFile).toBeNull();
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

    await provider.openFile(checkout(fakeRepository({ base: text(""), result: binary })), comparison(), image);

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
    await provider.openFile(checkout(fakeRepository({ base: text("old"), result: text("new") })), comparison(), file());
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

    const result = provider.openFile(checkout(fakeRepository({ base: text("old"), result: text("new") })), comparison(), file());

    await expect(result).rejects.toThrow("editor failed");
    expect(opened.map((uri) => provider.provideTextDocumentContent(uri))).toEqual([
      UNAVAILABLE_DOCUMENT_TEXT,
      UNAVAILABLE_DOCUMENT_TEXT,
    ]);
  });

  it("opens nothing when the snapshot has already been released", async () => {
    const repository = fakeRepository({ base: text(""), result: text("") });
    repository.readFile = vi.fn(() => Promise.reject(new Error("This comparison is no longer available.")));

    await expect(provider.openFile(checkout(repository), comparison(), file())).rejects.toThrow("no longer available");
    expect(vscodeMock.executedCommands).toEqual([]);
  });

  it("clears its cache and stops listening on dispose", async () => {
    await provider.openFile(checkout(fakeRepository({ base: text("old"), result: text("new") })), comparison(), file());
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
    provider = new HistoryDiffProvider(panels, () => undefined);
  });

  async function openPanel(changes: Partial<ComparisonFile> = {}): Promise<TwoWayDiffRequest> {
    await provider.openFile(checkout(fakeRepository({ base: text("old\n"), result: text("new\n") })), comparison(), file(changes));
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

  it("offers the right side's file in the repository's working tree as the working copy", async () => {
    const request = await openPanel({ status: "renamed", base: { path: "src/old.ts", blob: "b".repeat(40), mode: "100644" } });

    expect(request.workingCopy?.fsPath).toBe(`${ROOT}/src/app.ts`);
  });

  it("takes the language from the base document of a deleted file", async () => {
    const request = await openPanel({ status: "deleted", result: null });

    expect(request.languageUri).toBe(request.base.uri);
    expect(request.result.path).toBe("");
    expect(request.workingCopy).toBeUndefined();
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

  it("reports the file its panel shows from when the tab shows it until the tab closes", async () => {
    const reported: unknown[] = [];
    provider.onDidChangeOpenedFile(() => reported.push(provider.openedFile));
    const request = await openPanel();
    expect(provider.openedFile).toBeNull();

    request.shown?.();
    request.release();

    expect(reported).toEqual([{ snapshotId: SNAPSHOT_ID, fileId: file().id }, null]);
    expect(provider.openedFile).toBeNull();
  });

  it("forgets both documents when the panel cannot open", async () => {
    panels.open = (request) => {
      panels.requests.push(request);
      return Promise.reject(new Error("panel failed"));
    };

    await expect(provider.openFile(checkout(fakeRepository({ base: text("a"), result: text("b") })), comparison(), file())).rejects.toThrow("panel failed");

    const [request] = panels.requests;
    expect(provider.provideTextDocumentContent(request.base.uri)).toBe(UNAVAILABLE_DOCUMENT_TEXT);
    expect(provider.provideTextDocumentContent(request.result.uri)).toBe(UNAVAILABLE_DOCUMENT_TEXT);
  });
});

describe("HistoryDiffProvider file steps", () => {
  let provider: HistoryDiffProvider;
  let panels: ReturnType<typeof fakePanels>;
  let logged: string[];
  const repository = fakeRepository({ base: text("old\n"), result: text("new\n") });

  /** A text change at `filePath`; IDs sort opposite to the list so only list order can decide neighbours. */
  function changed(id: string, filePath: string, changes: Partial<ComparisonFile> = {}): ComparisonFile {
    return file({
      id,
      base: { path: filePath, blob: "b".repeat(40), mode: "100644" },
      result: { path: filePath, blob: "c".repeat(40), mode: "100644" },
      ...changes,
    });
  }

  const zebra = changed("33333333-3333-4333-8333-333333333333", "zebra.ts");
  const apple = changed("22222222-2222-4222-8222-222222222222", "apple.ts");
  const mango = changed("11111111-1111-4111-8111-111111111111", "mango.ts");
  const listed = comparison({ files: [zebra, apple, mango] });

  beforeEach(() => {
    resetVscodeMock();
    panels = fakePanels();
    logged = [];
    provider = new HistoryDiffProvider(panels, (message) => logged.push(message));
  });

  function lastRequest(): TwoWayDiffRequest {
    return panels.requests[panels.requests.length - 1];
  }

  /** The neighbouring files found for `request`; undefined when it has no file list. */
  function neighboursOf(request = lastRequest()): Promise<AdjacentFiles> | undefined {
    return panels.neighbours.get(request);
  }

  it("starts a file opened from the list at its first change", async () => {
    await provider.openFile(checkout(repository), listed, apple);

    expect(lastRequest().startAt).toBe("first");
  });

  it("opens the next listed file at its first change and the previous one at its last", async () => {
    await provider.openFile(checkout(repository), listed, apple);
    const adjacentFiles = await neighboursOf();

    await adjacentFiles?.next?.();
    expect(lastRequest().result.path).toBe("mango.ts");
    expect(lastRequest().startAt).toBe("first");

    await adjacentFiles?.previous?.();
    expect(lastRequest().result.path).toBe("zebra.ts");
    expect(lastRequest().startAt).toBe("last");
  });

  it("keeps stepping from a file it opened", async () => {
    await provider.openFile(checkout(repository), listed, zebra);

    await (await neighboursOf())?.next?.();
    await (await neighboursOf())?.next?.();

    expect(lastRequest().result.path).toBe("mango.ts");
  });

  it("keeps reporting the file a step showed when the tab releases the file it replaced", async () => {
    await provider.openFile(checkout(repository), listed, apple);
    const first = lastRequest();
    first.shown?.();

    await (await neighboursOf(first))?.next?.();
    lastRequest().shown?.();
    first.release();

    expect(provider.openedFile).toEqual({ snapshotId: SNAPSHOT_ID, fileId: mango.id });
  });

  it("has no previous file before the first listed file and no next one after the last", async () => {
    await provider.openFile(checkout(repository), listed, zebra);
    expect(await neighboursOf()).toEqual({ next: expect.any(Function) });

    await provider.openFile(checkout(repository), listed, mango);
    expect(await neighboursOf()).toEqual({ previous: expect.any(Function) });
  });

  it("still has a file list, with no neighbours, for a single changed file", async () => {
    await provider.openFile(checkout(repository), comparison({ files: [apple] }), apple);

    expect(await neighboursOf()).toEqual({});
  });

  it("skips binary files and files whose content did not change", async () => {
    const binary = changed("44444444-4444-4444-8444-444444444444", "logo.png", { contentKind: "binary" });
    const renamedOnly = changed("55555555-5555-4555-8555-555555555555", "moved.ts", {
      status: "renamed",
      base: { path: "old.ts", blob: "f".repeat(40), mode: "100644" },
      result: { path: "moved.ts", blob: "f".repeat(40), mode: "100644" },
    });
    const files = comparison({ files: [zebra, binary, renamedOnly, mango] });

    await provider.openFile(checkout(repository), files, zebra);
    await (await neighboursOf())?.next?.();
    expect(lastRequest().result.path).toBe("mango.ts");

    await (await neighboursOf())?.previous?.();
    expect(lastRequest().result.path).toBe("zebra.ts");
  });

  /** `repository`, except that the files with `nonTextIds` read as too large on both sides. */
  function withOversize(...nonTextIds: string[]): HistoryRepository {
    const oversize: FileContentResult = {
      kind: "nonText",
      reason: "oversize",
      explanation: "Too large to show.",
      sizeBytes: 20_000_000,
      mode: "100644",
    };
    return {
      ...repository,
      readFile: (snapshotId, fileId, side, signal) =>
        nonTextIds.includes(fileId) ? Promise.resolve(oversize) : repository.readFile(snapshotId, fileId, side, signal),
    };
  }

  it("passes over a file that reads as not text", async () => {
    const oversized = withOversize(apple.id);

    await provider.openFile(checkout(oversized), listed, zebra);
    await (await neighboursOf())?.next?.();
    expect(lastRequest().result.path).toBe("mango.ts");

    await (await neighboursOf())?.previous?.();
    expect(lastRequest().result.path).toBe("zebra.ts");
  });

  it("offers no step in a direction where no file reads as text, as a step there would open no diff", async () => {
    await provider.openFile(checkout(withOversize(apple.id, mango.id)), listed, zebra);

    expect(await neighboursOf()).toEqual({});
  });

  it("says the comparison has changed instead of stepping to a neighbour read before the snapshot was released", async () => {
    let isReleased = false;
    const releasable: HistoryRepository = { ...repository, hasSnapshot: () => !isReleased };
    await provider.openFile(checkout(releasable), listed, apple);
    const shown = lastRequest();

    isReleased = true;
    await (await neighboursOf(shown))?.next?.();

    expect(lastRequest()).toBe(shown);
    expect(vscodeMock.messages).toEqual([{ level: "information", text: COMPARISON_CHANGED_MESSAGE }]);
    expect(logged).toEqual([]);
  });

  it("logs a step read that fails for another reason and offers no step there", async () => {
    const failing: HistoryRepository = {
      ...repository,
      readFile: (snapshotId, fileId, side, signal) =>
        fileId === mango.id ? Promise.reject(new Error("cat-file crashed")) : repository.readFile(snapshotId, fileId, side, signal),
    };

    await provider.openFile(checkout(failing), listed, apple);

    expect(await neighboursOf()).toEqual({ previous: expect.any(Function) });
    expect(logged).toEqual(["Could not read mango.ts for a file step: cat-file crashed"]);
  });

  it("reads at most twenty files in a direction before it stops offering a step there", async () => {
    const skipped = Array.from({ length: 21 }, (_, index) =>
      changed(`999999${String(index).padStart(2, "0")}-9999-4999-8999-999999999999`, `skipped${index}.ts`));
    const counting = fakeRepository({ base: text("old\n"), result: text("new\n") });
    const oversize: FileContentResult = { kind: "nonText", reason: "oversize", explanation: "Too large.", sizeBytes: 1, mode: "100644" };
    const reader: HistoryRepository = {
      ...counting,
      readFile: (snapshotId, fileId, side, signal) =>
        skipped.some((skippedFile) => skippedFile.id === fileId)
          ? counting.readFile(snapshotId, fileId, side, signal).then(() => oversize)
          : counting.readFile(snapshotId, fileId, side, signal),
    };

    await provider.openFile(checkout(reader), comparison({ files: [zebra, ...skipped, mango] }), zebra);

    expect(await neighboursOf()).toEqual({});
    expect(counting.reads.filter((read) => !read.includes(zebra.id))).toHaveLength(20 * 2);
  });

  it("does not read again the file a step leaves", async () => {
    const counting = fakeRepository({ base: text("old\n"), result: text("new\n") });
    await provider.openFile(checkout(counting), listed, apple);
    counting.reads.length = 0;

    await (await neighboursOf())?.next?.();

    expect(lastRequest().result.path).toBe("mango.ts");
    expect(await neighboursOf()).toEqual({ previous: expect.any(Function) });
    expect(counting.reads).toEqual([]);
  });

  it("shows only the later of two opens when the earlier one is still reading", async () => {
    let releaseApple = (): void => undefined;
    const appleRead = new Promise<void>((resolve) => {
      releaseApple = resolve;
    });
    const slow: HistoryRepository = {
      ...repository,
      readFile: (snapshotId, fileId, side, signal) => {
        const read = repository.readFile(snapshotId, fileId, side, signal);
        return fileId === apple.id ? appleRead.then(() => read) : read;
      },
    };

    const earlier = provider.openFile(checkout(slow), comparison({ files: [apple] }), apple);
    await provider.openFile(checkout(slow), comparison({ files: [mango] }), mango);
    releaseApple();
    await earlier;

    expect(panels.requests.map((request) => request.result.path)).toEqual(["mango.ts"]);
  });

  it("cancels the first of two steps asked for at once, so only the later one offers steps", async () => {
    await provider.openFile(checkout(repository), listed, zebra);
    const adjacentFiles = await neighboursOf();

    await Promise.all([adjacentFiles?.next?.(), adjacentFiles?.next?.()]);

    const [, earlier, later] = panels.requests;
    expect(panels.requests.map((request) => request.result.path)).toEqual(["zebra.ts", "apple.ts", "apple.ts"]);
    expect(await neighboursOf(earlier)).toEqual({});
    expect(await neighboursOf(later)).toEqual({ previous: expect.any(Function), next: expect.any(Function) });
  });

  it("steps into added and deleted files", async () => {
    const added = changed("66666666-6666-4666-8666-666666666666", "new.ts", { status: "added", base: null });
    const deleted = changed("77777777-7777-4777-8777-777777777777", "gone.ts", { status: "deleted", result: null });

    await provider.openFile(checkout(repository), comparison({ files: [added, deleted] }), added);
    await (await neighboursOf())?.next?.();

    expect(lastRequest().base.path).toBe("gone.ts");
  });

  /**
   * `repository`, except that reads of `heldIds` wait until `releaseReads` and then fail with `failure` if given; their
   * signals are recorded.
   */
  function heldReads(heldIds: readonly string[], failure?: Error): { reader: HistoryRepository; signals: AbortSignal[]; releaseReads(): void } {
    let releaseReads = (): void => undefined;
    const held = new Promise<void>((resolve) => (releaseReads = resolve));
    const signals: AbortSignal[] = [];
    const reader: HistoryRepository = {
      ...repository,
      readFile: (snapshotId, fileId, side, signal) => {
        if (!heldIds.includes(fileId)) {
          return repository.readFile(snapshotId, fileId, side, signal);
        }
        signals.push(signal);
        return held.then(() => (failure === undefined ? repository.readFile(snapshotId, fileId, side, signal) : Promise.reject(failure)));
      },
    };
    return { reader, signals, releaseReads: () => releaseReads() };
  }

  it("shows the file before it reads the files a step reaches, reading both directions at once", async () => {
    const { reader, signals, releaseReads } = heldReads([zebra.id, mango.id]);

    const opened = provider.openFile(checkout(reader), listed, apple);
    await settle();

    expect(panels.requests.map((request) => request.result.path)).toEqual(["apple.ts"]);
    expect(signals).toHaveLength(4);
    releaseReads();
    await opened;
    expect(await neighboursOf()).toEqual({ previous: expect.any(Function), next: expect.any(Function) });
  });

  it("stops reading for the steps of a file once another replaces it in the tab, and offers none from it", async () => {
    const { reader, signals, releaseReads } = heldReads([zebra.id, mango.id]);
    const opened = provider.openFile(checkout(reader), listed, apple);
    await settle();
    const left = lastRequest();
    expect(left?.result.path).toBe("apple.ts");

    await provider.openFile(checkout(repository), comparison({ files: [mango] }), mango);

    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true, true]);
    releaseReads();
    await opened;
    expect(await neighboursOf(left)).toEqual({});
  });

  it("keeps finding the steps of the shown file while a file that opens elsewhere replaces its opening", async () => {
    const { reader, signals, releaseReads } = heldReads([zebra.id, mango.id]);
    const opened = provider.openFile(checkout(reader), listed, apple);
    await settle();
    const shown = lastRequest();
    const binary: FileContentResult = { kind: "nonText", reason: "binary", explanation: "Binary.", sizeBytes: 4, mode: "100644" };
    const image = changed("44444444-4444-4444-8444-444444444444", "logo.png", { contentKind: "binary" });

    await provider.openFile(checkout(fakeRepository({ base: binary, result: binary })), comparison({ files: [image] }), image);

    expect(lastCommand().command).toBe("vscode.open");
    expect(signals.some((signal) => signal.aborted)).toBe(false);
    releaseReads();
    await opened;
    expect(await neighboursOf(shown)).toEqual({ previous: expect.any(Function), next: expect.any(Function) });
  });

  it("stops finding the steps of the shown file once the provider is disposed", async () => {
    const { reader, signals, releaseReads } = heldReads([zebra.id, mango.id]);
    const opened = provider.openFile(checkout(reader), listed, apple);
    await settle();
    const shown = lastRequest();

    provider.dispose();

    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true, true]);
    releaseReads();
    await opened;
    expect(await neighboursOf(shown)).toEqual({});
  });

  it("offers no step toward a file whose read finds the comparison released while the file shows", async () => {
    const released = new HistorySnapshotError("This comparison is no longer available.", "unknownSnapshot");
    const { reader, releaseReads } = heldReads([mango.id], released);

    const opened = provider.openFile(checkout(reader), listed, apple);
    await settle();
    expect(panels.requests).toHaveLength(1);
    releaseReads();
    await opened;

    expect(await neighboursOf()).toEqual({ previous: expect.any(Function) });
    expect(logged).toEqual([]);
  });

  it("has no file list for a file missing from its comparison's list", async () => {
    await provider.openFile(checkout(repository), listed, changed("88888888-8888-4888-8888-888888888888", "other.ts"));

    expect(await neighboursOf()).toBeUndefined();
  });
});
