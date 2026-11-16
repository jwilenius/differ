import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { HistoryGitError } from "../git/historyGitCommand";
import type { HistoryFileOpener } from "../host/vscode/historyDiffProvider";
import {
  COMPARE_DELAY_MS,
  COMPARISON_CHANGED_MESSAGE,
  FOCUS_HISTORY_VIEW_COMMAND,
  HistoryViewProvider,
  OPEN_HISTORY_COMMAND,
} from "../host/vscode/historyViewProvider";
import type { ClosableHistoryRepository } from "../host/vscode/historyViewProvider";
import type {
  ComparisonRequest,
  ComparisonResult,
  HistoryCommit,
  HistoryData,
  OpenedFile,
  ReadyResult,
} from "../model/historyTypes";
import { HISTORY_PAGE_SIZE } from "../render/html/historyRenderer";
import type { HistoryPublicState, HistoryUpdate } from "../render/html/historyRenderer";
import { changeConfiguration, changeWorkspaceFolders, createFakeWebviewView, resetVscodeMock, vscodeMock } from "./vscodeMock";
import type { FakeWebviewView } from "./vscodeMock";

const ROOT_A = "/work/alpha";
const ROOT_B = "/work/beta";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const F1 = "f".repeat(40);
const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";

function commit(oid: string, parents: readonly string[], subject: string): HistoryCommit {
  return { oid, parents, author: "Ann", authoredDate: "2026-01-01T00:00:00Z", subject };
}

/** feature (F1) and main (C3) both grow from C1. */
const HISTORY: HistoryData = {
  commits: [
    commit(F1, [C1], "Feature work"),
    commit(C3, [C2], "Third change"),
    commit(C2, [C1], "Second change"),
    commit(C1, [], "Initial import"),
  ],
  refs: [
    { kind: "localBranch", name: "main", oid: C3 },
    { kind: "localBranch", name: "feature", oid: F1 },
  ],
  isTruncated: false,
};

function linearOid(index: number): string {
  return (index + 1).toString(16).padStart(40, "a");
}

/** `count` commits in one line, newest first. */
function linearHistory(count: number): HistoryData {
  const commits = Array.from({ length: count }, (_, index) => commit(linearOid(index), index + 1 < count ? [linearOid(index + 1)] : [], `Change ${index}`));
  return { commits, refs: [{ kind: "localBranch", name: "main", oid: linearOid(0) }], isTruncated: false };
}

function readyResult(request: ComparisonRequest): ReadyResult {
  return {
    kind: "ready",
    snapshotId: SNAPSHOT_ID,
    base: { kind: "commit", oid: C1, subject: "Initial import" },
    orderedOids: request.selectedOids,
    files: [{
      id: FILE_ID,
      status: "modified",
      base: { path: "a.txt", blob: "a".repeat(40), mode: "100644" },
      result: { path: "a.txt", blob: "b".repeat(40), mode: "100644" },
      contentKind: "text",
    }],
  };
}

/** Port fake recording calls; `compare` waits for `finishCompare` when `isCompareHeld`. */
class FakeRepository implements ClosableHistoryRepository {
  loadCount = 0;
  /** The commit cap of every load, in order. */
  readonly loadCaps: number[] = [];
  readonly resolvedRefs: string[] = [];
  readonly compareRequests: ComparisonRequest[] = [];
  readonly compareSignals: AbortSignal[] = [];
  readonly released: string[] = [];
  isDisposed = false;
  isCompareHeld = false;
  /** Rejects every load while set. */
  loadFailure: Error | null = null;
  private heldCompares: (() => void)[] = [];

  constructor(private history: HistoryData = HISTORY) {}

  setHistory(history: HistoryData): void {
    this.history = history;
  }

  loadHistory(maxCommits: number): Promise<HistoryData> {
    this.loadCount += 1;
    this.loadCaps.push(maxCommits);
    return this.loadFailure ? Promise.reject(this.loadFailure) : Promise.resolve(this.history);
  }

  resolveRef(ref: string): Promise<HistoryCommit> {
    this.resolvedRefs.push(ref);
    const oid = this.history.refs.find((candidate) => candidate.name === ref)?.oid ?? C1;
    return Promise.resolve(this.history.commits.find((candidate) => candidate.oid === oid)!);
  }

  async compare(request: ComparisonRequest, signal: AbortSignal): Promise<ComparisonResult> {
    this.compareRequests.push(request);
    this.compareSignals.push(signal);
    if (this.isCompareHeld) {
      await new Promise<void>((resolve) => this.heldCompares.push(resolve));
    }
    return readyResult(request);
  }

  finishCompare(): void {
    this.heldCompares.forEach((resolve) => resolve());
    this.heldCompares = [];
  }

  readFile(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  releaseSnapshot(snapshotId: string): void {
    this.released.push(snapshotId);
  }

  dispose(): Promise<void> {
    this.isDisposed = true;
    return Promise.resolve();
  }
}

/** Lets promise chains that do not depend on fake timers run to completion. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** State of the last assigned document, before any update. */
function documentState(view: FakeWebviewView): HistoryPublicState {
  const match = /data-history="([^"]*)"/.exec(view.webview.html);
  return JSON.parse(decodeHtml(match![1])) as HistoryPublicState;
}

/** Updates posted to the current document. */
function updates(view: FakeWebviewView): readonly HistoryUpdate[] {
  return view.webview.postedSinceHtml as readonly HistoryUpdate[];
}

/** What the panel shows: the last assigned document patched by every update posted to it, as the client applies them. */
function page(view: FakeWebviewView): { readonly html: string; readonly state: HistoryPublicState } {
  let html = view.webview.html;
  let state = documentState(view);
  for (const update of updates(view)) {
    html = Object.entries(update.regions).reduce((patched, [id, markup]) => replaceElement(patched, id, markup), html);
    const tableEnd = html.indexOf("</tbody>", html.indexOf(` id="history-commits"`));
    html = html.slice(0, tableEnd) + update.appendedRows + html.slice(tableEnd);
    state = update.state;
  }
  return { html, state };
}

function publicState(view: FakeWebviewView): HistoryPublicState {
  return page(view).state;
}

function shownHtml(view: FakeWebviewView): string {
  return page(view).html;
}

/** Rows shown in the commit table, in order. */
function shownRows(view: FakeWebviewView): readonly string[] {
  return [...shownHtml(view).matchAll(/<tr class="commit-row[^"]*" role="row" data-oid="([0-9a-f]+)"/g)].map((match) => match[1]!);
}

/** Replaces the element with `id` in the renderer's well-formed markup, as setting its `outerHTML` would. */
function replaceElement(html: string, id: string, replacement: string): string {
  const idAt = html.indexOf(` id="${id}"`);
  if (idAt < 0) {
    throw new Error(`no #${id}`);
  }
  const start = html.lastIndexOf("<", idAt);
  const tag = /^<([a-z0-9]+)/.exec(html.slice(start))![1]!;
  return html.slice(0, start) + replacement + html.slice(elementEnd(html, start, tag));
}

function elementEnd(html: string, start: number, tag: string): number {
  if (tag === "input") {
    return html.indexOf(">", start) + 1;
  }
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  pattern.lastIndex = start;
  let depth = 0;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) {
      return match.index + match[0].length;
    }
  }
  throw new Error(`unclosed <${tag}>`);
}

/** Reports the current document loaded, as its script does. */
function loadDocument(view: FakeWebviewView): void {
  view.webview.fireDidReceiveMessage({ type: "ready", revision: documentState(view).revision });
}

function folder(fsPath: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(fsPath), name: fsPath, index: 0 };
}

describe("HistoryViewProvider", () => {
  let repositories: Map<string, FakeRepository>;
  /** `loadFailure` of each repository the provider creates, so its first load can fail. */
  let initialLoadFailure: Error | null;
  /** History each repository the provider creates loads. */
  let initialHistory: HistoryData;
  let fileOpener: HistoryFileOpener & { calls: unknown[][]; openedFile: OpenedFile | null };
  let openedFileChanges: vscode.EventEmitter<void>;
  let log: string[];
  let provider: HistoryViewProvider;
  let view: FakeWebviewView;

  function createProvider(roots: readonly string[] = [ROOT_A]): HistoryViewProvider {
    vscodeMock.workspaceFolders = roots.map(folder);
    return new HistoryViewProvider({
      mediaRoot: vscode.Uri.file("/extension/media"),
      fileOpener,
      log: { appendLine: (line) => void log.push(line) },
      createRepository: (root) => {
        const repository = new FakeRepository(initialHistory);
        repository.loadFailure = initialLoadFailure;
        repositories.set(root, repository);
        return repository;
      },
      findRepositoryRoot: (directory) => Promise.resolve(directory),
    });
  }

  async function open(roots?: readonly string[]): Promise<void> {
    provider = createProvider(roots);
    view = createFakeWebviewView();
    provider.resolveWebviewView(view);
    loadDocument(view);
    await settle();
  }

  async function send(message: Record<string, unknown>): Promise<void> {
    view.webview.fireDidReceiveMessage({ revision: publicState(view).revision, ...message });
    await settle();
  }

  /** Plays the diff panel starting to show `openedFile`, or closing. */
  function showInDiffPanel(openedFile: OpenedFile | null): void {
    fileOpener.openedFile = openedFile;
    openedFileChanges.fire();
  }

  async function selectAndCompare(oids: readonly string[]): Promise<void> {
    await send({ type: "select", oids, focusedOid: oids[0] ?? null });
    await vi.advanceTimersByTimeAsync(COMPARE_DELAY_MS);
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetVscodeMock();
    repositories = new Map();
    initialLoadFailure = null;
    initialHistory = HISTORY;
    log = [];
    openedFileChanges = new vscode.EventEmitter<void>();
    fileOpener = {
      calls: [],
      openFile(...args) {
        this.calls.push(args);
        return Promise.resolve();
      },
      openedFile: null,
      onDidChangeOpenedFile: openedFileChanges.event,
    };
  });

  afterEach(async () => {
    await provider.dispose();
    vi.useRealTimers();
  });

  it("configures the webview and publishes the discovered repository's history", async () => {
    await open();

    expect(view.webview.options).toEqual({ enableScripts: true, localResourceRoots: [vscode.Uri.file("/extension/media")] });
    expect(shownHtml(view)).toContain("Third change");
    expect(shownHtml(view)).toContain("history.js");
    expect(publicState(view).repositoryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(repositories.get(ROOT_A)?.loadCount).toBe(1);
  });

  it("compares once, 150 ms after the last selection change", async () => {
    await open();
    await send({ type: "select", oids: [C2], focusedOid: C2 });
    await send({ type: "select", oids: [C2, C3], focusedOid: C3 });
    const repository = repositories.get(ROOT_A)!;

    await vi.advanceTimersByTimeAsync(COMPARE_DELAY_MS - 1);
    expect(repository.compareRequests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(repository.compareRequests.map((request) => request.selectedOids)).toEqual([[C2, C3]]);
    expect(publicState(view).snapshotId).toBe(SNAPSHOT_ID);
  });

  it("routes a file activation to the opener with the current snapshot", async () => {
    await open();
    await selectAndCompare([C3]);

    await send({ type: "openFile", snapshotId: SNAPSHOT_ID, fileId: FILE_ID });

    expect(fileOpener.calls).toHaveLength(1);
    const [repository, comparison, file] = fileOpener.calls[0] as [unknown, ReadyResult, { id: string }];
    expect(repository).toBe(repositories.get(ROOT_A));
    expect(comparison.snapshotId).toBe(SNAPSHOT_ID);
    expect(file.id).toBe(FILE_ID);
  });

  it("marks the file the diff panel shows with a state-only update until its tab closes", async () => {
    await open();
    await selectAndCompare([C3]);
    const posted = updates(view).length;

    showInDiffPanel({ snapshotId: SNAPSHOT_ID, fileId: FILE_ID });

    expect(updates(view)).toHaveLength(posted + 1);
    const update = updates(view).at(-1)!;
    expect(update.state.openFileId).toBe(FILE_ID);
    expect(update.regions).toEqual({});
    expect(update.appendedRows).toBe("");
    showInDiffPanel(null);
    expect(publicState(view).openFileId).toBeNull();
    expect(view.webview.htmlWrites).toBe(1);
  });

  it("unmarks the open file once the selection no longer lists it", async () => {
    await open();
    await selectAndCompare([C3]);
    showInDiffPanel({ snapshotId: SNAPSHOT_ID, fileId: FILE_ID });

    await send({ type: "select", oids: [C2], focusedOid: C2 });

    expect(publicState(view).openFileId).toBeNull();
  });

  it("shows a concise error when the opener reports an expired snapshot", async () => {
    await open();
    await selectAndCompare([C3]);
    fileOpener.openFile = () => Promise.reject(new Error("This comparison is no longer available."));

    await send({ type: "openFile", snapshotId: SNAPSHOT_ID, fileId: FILE_ID });

    expect(vscodeMock.messages).toEqual([{ level: "error", text: "This comparison is no longer available." }]);
    expect(log.some((line) => line.includes("no longer available"))).toBe(true);
  });

  it("applies a selection made on the page a comparison replaced", async () => {
    await open();
    await selectAndCompare([C2]);
    const pageBeforeCompareFinished = publicState(view).revision - 1;

    view.webview.fireDidReceiveMessage({ type: "select", revision: pageBeforeCompareFinished, oids: [C2, C3], focusedOid: C3 });
    await settle();

    expect(publicState(view).selectedOids).toEqual([C2, C3]);
  });

  it("rejects intents sent from a page of another repository", async () => {
    await open([ROOT_A, ROOT_B]);
    const alphaRevision = publicState(view).revision;
    const betaId = /<option value="([^"]+)">beta<\/option>/.exec(shownHtml(view))![1];
    await send({ type: "repository", repositoryId: betaId });

    view.webview.fireDidReceiveMessage({ type: "select", revision: alphaRevision, oids: [C3], focusedOid: C3 });
    view.webview.fireDidReceiveMessage({ type: "openFile", revision: alphaRevision, snapshotId: SNAPSHOT_ID, fileId: FILE_ID });
    await settle();

    expect(publicState(view).selectedOids).toEqual([]);
    expect(fileOpener.calls).toHaveLength(0);
  });

  it("accepts only the focus of a stale presentation", async () => {
    await open();
    const staleRevision = publicState(view).revision;
    await send({ type: "select", oids: [C2], focusedOid: C2 });

    view.webview.fireDidReceiveMessage({
      type: "presentation",
      revision: staleRevision,
      search: "feature",
      branch: null,
      focusedOid: C3,
      rowLimit: 200,
    });
    await settle();

    expect(publicState(view)).toMatchObject({ focusedOid: C3, search: "" });
  });

  it("ignores a stale presentation from another repository's page", async () => {
    await open([ROOT_A, ROOT_B]);
    const alphaRevision = publicState(view).revision;
    const betaId = /<option value="([^"]+)">beta<\/option>/.exec(shownHtml(view))![1];
    await send({ type: "repository", repositoryId: betaId });

    view.webview.fireDidReceiveMessage({ type: "presentation", revision: alphaRevision, search: "", branch: null, focusedOid: C3, rowLimit: 200 });
    await settle();

    expect(publicState(view)).toMatchObject({ repositoryId: betaId, focusedOid: null });
  });

  it("does not republish a selection or presentation that changes nothing", async () => {
    await open();
    await send({ type: "select", oids: [C2, C3], focusedOid: C3 });
    await send({ type: "presentation", search: "", branch: null, focusedOid: C3, rowLimit: 200 });
    const revision = publicState(view).revision;

    await send({ type: "select", oids: [C3, C2], focusedOid: C3 });
    await send({ type: "presentation", search: "", branch: null, focusedOid: C3, rowLimit: 200 });

    expect(publicState(view).revision).toBe(revision);
  });

  it("publishes a focus change made with an unchanged selection", async () => {
    await open();
    await send({ type: "select", oids: [C2, C3], focusedOid: C3 });

    await send({ type: "select", oids: [C2, C3], focusedOid: C2 });

    expect(publicState(view).focusedOid).toBe(C2);
  });

  it("explains that a file from a replaced comparison must be opened again", async () => {
    await open();
    await selectAndCompare([C3]);

    await send({ type: "openFile", snapshotId: "33333333-3333-4333-8333-333333333333", fileId: FILE_ID });

    expect(fileOpener.calls).toHaveLength(0);
    expect(vscodeMock.messages).toEqual([{ level: "information", text: COMPARISON_CHANGED_MESSAGE }]);
  });

  it("adds repositories of new workspace folders and keeps existing sessions", async () => {
    await open([ROOT_A]);
    await send({ type: "select", oids: [C2], focusedOid: C2 });
    const alphaId = publicState(view).repositoryId;

    changeWorkspaceFolders([folder(ROOT_A), folder(ROOT_B)]);
    await settle();

    expect(shownHtml(view)).toContain(">beta</option>");
    expect(publicState(view)).toMatchObject({ repositoryId: alphaId, selectedOids: [C2] });
    expect(repositories.get(ROOT_A)?.loadCount).toBe(1);
  });

  it("finds repositories added to the workspace on refresh", async () => {
    await open([]);
    vscodeMock.workspaceFolders = [folder(ROOT_B)];

    await send({ type: "refresh" });

    expect(shownHtml(view)).toContain(">beta</option>");
    expect(repositories.get(ROOT_B)?.loadCount).toBe(1);
  });

  it("runs discovery again when folders change while it is in flight", async () => {
    vscodeMock.workspaceFolders = [folder(ROOT_A)];
    const lookups: string[] = [];
    let releaseFirst: () => void = () => undefined;
    provider = new HistoryViewProvider({
      mediaRoot: vscode.Uri.file("/extension/media"),
      fileOpener,
      log: { appendLine: (line) => void log.push(line) },
      createRepository: (root) => {
        const repository = new FakeRepository();
        repositories.set(root, repository);
        return repository;
      },
      findRepositoryRoot: async (directory) => {
        lookups.push(directory);
        if (lookups.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return directory;
      },
    });
    view = createFakeWebviewView();
    provider.resolveWebviewView(view);
    loadDocument(view);

    changeWorkspaceFolders([folder(ROOT_A), folder(ROOT_B)]);
    releaseFirst();
    await settle();

    expect(lookups).toEqual([ROOT_A, ROOT_A, ROOT_B]);
    expect(shownHtml(view)).toContain(">beta</option>");
    expect(repositories.get(ROOT_A)?.loadCount).toBe(1);
  });

  it("ignores malformed messages and selections of unknown commits", async () => {
    await open();
    const revision = publicState(view).revision;

    view.webview.fireDidReceiveMessage({ type: "select", revision, oids: ["not-an-oid"], focusedOid: null });
    await send({ type: "select", oids: ["9".repeat(40)], focusedOid: null });

    expect(publicState(view).selectedOids).toEqual([]);
    expect(log).toHaveLength(2);
  });

  it("posts nothing until the document reports ready, then brings it up to date", async () => {
    provider = createProvider();
    view = createFakeWebviewView();
    provider.resolveWebviewView(view);
    await settle();
    expect(view.webview.postedMessages).toEqual([]);

    loadDocument(view);

    expect(view.webview.htmlWrites).toBe(1);
    expect(updates(view)).toHaveLength(1);
    expect(shownRows(view)).toEqual([F1, C3, C2, C1]);
  });

  it("brings a document that loads again from its markup up to date, ignoring other documents' ready", async () => {
    await open();
    await send({ type: "select", oids: [C2], focusedOid: C2 });
    const posted = updates(view).length;

    view.webview.fireDidReceiveMessage({ type: "ready", revision: publicState(view).revision });
    expect(updates(view)).toHaveLength(posted);

    loadDocument(view);
    const resync = updates(view).at(-1)!;
    expect(updates(view)).toHaveLength(posted + 1);
    expect(resync.state.selectedOids).toEqual([C2]);
    expect(resync.regions["history-commits"]).toBeDefined();
    expect(resync.regions["history-selection"]).toContain("1 selected");
    expect(view.webview.htmlWrites).toBe(1);
  });

  it("updates the panel in place, sending only what a selection changed", async () => {
    await open();
    const posted = updates(view).length;

    await send({ type: "select", oids: [C2], focusedOid: C2 });

    expect(view.webview.htmlWrites).toBe(1);
    expect(updates(view)).toHaveLength(posted + 1);
    const update = updates(view).at(-1)!;
    expect(update.state).toMatchObject({ selectedOids: [C2], focusedOid: C2 });
    expect(update.regions["history-commits"]).toBeUndefined();
    expect(update.appendedRows).toBe("");
    expect(update.regions["history-selection"]).toContain("1 selected");
  });

  it("sends only the details for a focus change", async () => {
    await open();
    await send({ type: "select", oids: [C2, C3], focusedOid: C3 });

    await send({ type: "select", oids: [C2, C3], focusedOid: C2 });

    const update = updates(view).at(-1)!;
    expect(Object.keys(update.regions)).toEqual(["history-details"]);
    expect(update.regions["history-details"]).toContain("Second change");
    expect(view.webview.htmlWrites).toBe(1);
  });

  it("appends only the new rows on Load more", async () => {
    initialHistory = linearHistory(HISTORY_PAGE_SIZE * 2 + 50);
    await open();
    expect(shownRows(view)).toHaveLength(HISTORY_PAGE_SIZE);

    await send({ type: "presentation", search: "", branch: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE * 2 });

    const update = updates(view).at(-1)!;
    expect(update.regions["history-commits"]).toBeUndefined();
    expect(update.appendedRows.match(/<tr /g)).toHaveLength(HISTORY_PAGE_SIZE);
    expect(update.appendedRows).toContain(`data-oid="${linearOid(HISTORY_PAGE_SIZE)}"`);
    expect(update.regions["history-commit-footer"]).toContain("Load more (50 more)");
    expect(shownRows(view)).toEqual(initialHistory.commits.slice(0, HISTORY_PAGE_SIZE * 2).map((entry) => entry.oid));
    expect(view.webview.htmlWrites).toBe(1);
  });

  it("replaces the rows when a search or branch filter changes them", async () => {
    await open();

    await send({ type: "presentation", search: "second", branch: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE });
    const searched = updates(view).at(-1)!;
    await send({ type: "presentation", search: "", branch: "refs/heads/feature", focusedOid: null, rowLimit: HISTORY_PAGE_SIZE });
    const filtered = updates(view).at(-1)!;

    expect(searched.regions["history-commits"]).toContain(`data-oid="${C2}"`);
    expect(searched.regions["history-commits"]).not.toContain(`data-oid="${C3}"`);
    expect(filtered.regions["history-commits"]).toContain(`data-oid="${F1}"`);
    expect(filtered.appendedRows).toBe("");
    expect(view.webview.htmlWrites).toBe(1);
  });

  it("updates the changed files and replay order when a comparison finishes", async () => {
    await open();

    await selectAndCompare([C3]);

    const finished = updates(view).at(-1)!;
    expect(finished.state.snapshotId).toBe(SNAPSHOT_ID);
    expect(finished.regions["history-files"]).toContain(`data-file-id="${FILE_ID}"`);
    expect(finished.regions["history-replay"]).toContain("Replay order");
    expect(finished.regions["history-commits"]).toBeUndefined();
    expect(view.webview.htmlWrites).toBe(1);
  });

  it("keeps the document of a hidden view current, so showing it loads the current state", async () => {
    await open();
    await send({ type: "select", oids: [C2], focusedOid: C2 });

    view.fireDidChangeVisibility(false);
    expect(view.webview.htmlWrites).toBe(2);
    expect(documentState(view).selectedOids).toEqual([C2]);
    await send({ type: "refresh" });
    expect(view.webview.htmlWrites).toBeGreaterThan(2);
    expect(view.webview.postedSinceHtml).toEqual([]);
    const writes = view.webview.htmlWrites;

    view.fireDidChangeVisibility(true);
    loadDocument(view);
    await send({ type: "select", oids: [C3], focusedOid: C3 });

    expect(view.webview.htmlWrites).toBe(writes);
    expect(publicState(view).selectedOids).toEqual([C3]);
  });

  it("takes a search from a document shown again as soon as it loads, posting nothing it already shows", async () => {
    await open();
    view.fireDidChangeVisibility(false);
    view.fireDidChangeVisibility(true);
    loadDocument(view);
    await settle();
    const shownRevision = documentState(view).revision;
    expect(updates(view)).toEqual([]);

    // Sent before any update could arrive.
    view.webview.fireDidReceiveMessage({ type: "presentation", revision: shownRevision, search: "c3", branch: null, focusedOid: null, rowLimit: 200 });
    await settle();

    expect(publicState(view).search).toBe("c3");
  });

  it("accepts a selection from a document older only by presentation changes", async () => {
    await open();
    const olderRevision = publicState(view).revision;
    await send({ type: "presentation", search: "", branch: null, focusedOid: C3, rowLimit: 200 });

    view.webview.fireDidReceiveMessage({ type: "select", revision: olderRevision, oids: [C3], focusedOid: C3 });
    await settle();

    expect(publicState(view).selectedOids).toEqual([C3]);
  });

  it("does not show cancelled Git operations when opening a file", async () => {
    await open();
    await selectAndCompare([C3]);
    fileOpener.openFile = () => Promise.reject(new HistoryGitError("Git was cancelled.", "cancelled", "detail"));

    await send({ type: "openFile", snapshotId: SNAPSHOT_ID, fileId: FILE_ID });

    expect(vscodeMock.messages).toEqual([]);
  });

  it("drops focus and branch filters that refresh removed, so later filtering still works", async () => {
    await open();
    await send({ type: "presentation", search: "", branch: "refs/heads/feature", focusedOid: F1, rowLimit: 200 });
    const repository = repositories.get(ROOT_A)!;
    repository.setHistory({ commits: HISTORY.commits.filter((candidate) => candidate.oid !== F1), refs: HISTORY.refs.slice(0, 1), isTruncated: false });

    await send({ type: "refresh" });
    expect(publicState(view)).toMatchObject({ focusedOid: null, branch: null });
    await send({ type: "presentation", search: "second", branch: null, focusedOid: null, rowLimit: 200 });

    expect(shownRows(view)).toEqual([C2]);
  });

  it("keeps a picked branch on its ref as the branch moves", async () => {
    const F2 = "e".repeat(40);
    await open();
    await send({ type: "presentation", search: "", branch: "refs/heads/feature", focusedOid: null, rowLimit: 200 });
    const repository = repositories.get(ROOT_A)!;
    repository.setHistory({
      commits: [commit(F2, [F1], "More feature work"), ...HISTORY.commits],
      refs: [{ kind: "localBranch", name: "feature", oid: F2 }, { kind: "localBranch", name: "main", oid: C3 }],
      isTruncated: false,
    });

    await send({ type: "refresh" });

    expect(publicState(view).branch).toBe("refs/heads/feature");
    expect(shownRows(view)).toEqual([F2, F1, C1]);
    expect(shownHtml(view)).toContain(`<option value="refs/heads/feature" selected>feature</option>`);
  });

  it("drops a picked branch whose tip is no longer loaded", async () => {
    await open();
    await send({ type: "presentation", search: "", branch: "refs/heads/feature", focusedOid: null, rowLimit: 200 });
    const repository = repositories.get(ROOT_A)!;
    repository.setHistory({ ...HISTORY, commits: HISTORY.commits.filter((candidate) => candidate.oid !== F1), isTruncated: true });

    await send({ type: "refresh" });

    expect(publicState(view).branch).toBeNull();
    expect(shownRows(view)).toEqual([C3, C2, C1]);
    expect(shownHtml(view)).toContain(`<option value="" selected>All branches</option>`);
  });

  it("takes only the focus of a presentation naming an unknown branch", async () => {
    await open();

    await send({ type: "presentation", search: "third", branch: "refs/heads/gone", focusedOid: C3, rowLimit: 200 });

    expect(publicState(view)).toMatchObject({ branch: null, search: "", focusedOid: C3 });
  });

  it("retries a failed comparison on refresh", async () => {
    await open();
    const repository = repositories.get(ROOT_A)!;
    const compare = repository.compare.bind(repository);
    repository.compare = () => Promise.reject(new Error("transient"));
    await selectAndCompare([C3]);
    expect(publicState(view).snapshotId).toBeNull();
    repository.compare = compare;

    await send({ type: "refresh" });
    await vi.advanceTimersByTimeAsync(COMPARE_DELAY_MS);
    await settle();

    expect(publicState(view).snapshotId).toBe(SNAPSHOT_ID);
  });

  it("leaves no compare timer behind when disposed during base resolution", async () => {
    await open();
    await send({ type: "select", oids: [C3], focusedOid: C3 });
    view.webview.fireDidReceiveMessage({ type: "base", revision: publicState(view).revision, ref: "main" });

    await provider.dispose();
    await settle();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores selection and presentation in a recreated view", async () => {
    await open();
    await selectAndCompare([C2, C3]);
    await send({ type: "presentation", search: "change", branch: null, focusedOid: C3, rowLimit: 200 });

    view.fireDidDispose();
    const recreated = createFakeWebviewView();
    provider.resolveWebviewView(recreated);
    await settle();
    expect(recreated.webview.htmlWrites).toBe(1);

    expect(publicState(recreated)).toMatchObject({ selectedOids: [C2, C3], search: "change", focusedOid: C3, snapshotId: SNAPSHOT_ID });
    expect(repositories.get(ROOT_A)?.loadCount).toBe(1);
  });

  it("keeps each repository's state separate when switching", async () => {
    await open([ROOT_A, ROOT_B]);
    await send({ type: "select", oids: [C2], focusedOid: C2 });
    const alphaId = publicState(view).repositoryId;
    const betaId = /<option value="([^"]+)">beta<\/option>/.exec(shownHtml(view))![1];

    await send({ type: "repository", repositoryId: betaId });
    expect(publicState(view)).toMatchObject({ repositoryId: betaId, selectedOids: [] });
    await send({ type: "select", oids: [C3], focusedOid: C3 });

    await send({ type: "repository", repositoryId: alphaId });
    expect(publicState(view)).toMatchObject({ repositoryId: alphaId, selectedOids: [C2] });
    await vi.advanceTimersByTimeAsync(COMPARE_DELAY_MS);
    await settle();
    expect(repositories.get(ROOT_A)?.compareRequests.map((request) => request.selectedOids)).toEqual([[C2]]);
    expect(repositories.get(ROOT_B)?.compareRequests.map((request) => request.selectedOids)).toEqual([[C3]]);
  });

  it("filters by search and branch without changing the selection", async () => {
    await open();
    await send({ type: "select", oids: [C2], focusedOid: C2 });

    await send({ type: "presentation", search: "THIRD", branch: null, focusedOid: C2, rowLimit: 200 });
    expect(shownRows(view)).toEqual([C3]);
    expect(publicState(view)).toMatchObject({ selectedOids: [C2], search: "THIRD" });
    expect(shownHtml(view)).toContain("1 hidden by filters");

    await send({ type: "presentation", search: "", branch: "refs/heads/feature", focusedOid: C2, rowLimit: 200 });
    expect(shownRows(view)).toEqual([F1, C1]);
    expect(publicState(view)).toMatchObject({ selectedOids: [C2], branch: "refs/heads/feature" });

    await send({ type: "presentation", search: "333", branch: null, focusedOid: C2, rowLimit: 200 });
    expect(shownRows(view)).toEqual([C3]);
  });

  it("keeps a pinned base on refresh and deselects commits that disappeared", async () => {
    await open();
    await send({ type: "select", oids: [C3, F1], focusedOid: C3 });
    await send({ type: "base", ref: "main" });
    const repository = repositories.get(ROOT_A)!;
    repository.setHistory({ commits: HISTORY.commits.filter((candidate) => candidate.oid !== F1), refs: HISTORY.refs.slice(0, 1), isTruncated: false });

    await send({ type: "refresh" });

    expect(repository.loadCount).toBe(2);
    expect(repository.resolvedRefs).toEqual(["main"]);
    expect(publicState(view).selectedOids).toEqual([C3]);
    expect(shownHtml(view)).toContain("base-pinned\">main</span>");
    expect(vscodeMock.messages.map((message) => message.text)).toEqual([
      "1 selected commit(s) are no longer in the history of alpha; they were deselected.",
    ]);
  });

  it("does not warn about a pinned base beyond the cut of a truncated history", async () => {
    await open();
    await send({ type: "base", ref: "main" });
    const repository = repositories.get(ROOT_A)!;
    repository.setHistory({ commits: HISTORY.commits.filter((candidate) => candidate.oid !== C3), refs: HISTORY.refs, isTruncated: true });

    await send({ type: "refresh" });

    expect(shownHtml(view)).toContain("base-pinned\">main</span>");
    expect(vscodeMock.messages).toEqual([]);
  });

  it("warns about a pinned base the complete history no longer reaches", async () => {
    await open();
    await send({ type: "base", ref: "main" });
    const repository = repositories.get(ROOT_A)!;
    repository.setHistory({ commits: HISTORY.commits.filter((candidate) => candidate.oid !== C3), refs: HISTORY.refs, isTruncated: false });

    await send({ type: "refresh" });

    expect(vscodeMock.messages.map((message) => message.text)).toEqual([
      "The pinned base 33333333 is not reachable from the loaded refs; it stays pinned.",
    ]);
  });

  describe("commit cap setting", () => {
    it("loads at most 20,000 commits by default", async () => {
      await open();

      expect(repositories.get(ROOT_A)?.loadCaps).toEqual([20_000]);
    });

    it("loads at most the configured number of commits, raising values below 100 to 100", async () => {
      vscodeMock.configuration.set("jwDiffer.historyMaxCommits", 300_000);
      await open();
      vscodeMock.configuration.set("jwDiffer.historyMaxCommits", 5);

      await send({ type: "refresh" });

      expect(repositories.get(ROOT_A)?.loadCaps).toEqual([300_000, 100]);
    });

    it("falls back to the default for a value that is not a number", async () => {
      vscodeMock.configuration.set("jwDiffer.historyMaxCommits", "lots");

      await open();

      expect(repositories.get(ROOT_A)?.loadCaps).toEqual([20_000]);
    });

    it("reloads loaded repositories with the new cap when the setting changes", async () => {
      await open([ROOT_A, ROOT_B]);
      const betaId = /<option value="([^"]+)">beta<\/option>/.exec(shownHtml(view))![1];

      changeConfiguration("jwDiffer.historyMaxCommits", 500);
      await settle();

      expect(repositories.get(ROOT_A)?.loadCaps).toEqual([20_000, 500]);
      expect(repositories.get(ROOT_B)?.loadCaps).toEqual([]);
      expect(shownHtml(view)).toContain("Third change");
      await send({ type: "repository", repositoryId: betaId });
      expect(repositories.get(ROOT_B)?.loadCaps).toEqual([500]);
    });

    it("retries a repository whose load failed when the setting changes", async () => {
      initialLoadFailure = new Error("Git output exceeded 64 MiB");
      await open();
      expect(shownHtml(view)).toContain("Could not load history");
      repositories.get(ROOT_A)!.loadFailure = null;

      changeConfiguration("jwDiffer.historyMaxCommits", 500);
      await settle();

      expect(repositories.get(ROOT_A)?.loadCaps).toEqual([20_000, 500]);
      expect(shownHtml(view)).not.toContain("Could not load history");
      expect(shownHtml(view)).toContain("Third change");
    });

    it("does not reload for other settings", async () => {
      await open();

      changeConfiguration("jwDiffer.historyDiffViewer", "native");
      await settle();

      expect(repositories.get(ROOT_A)?.loadCaps).toEqual([20_000]);
    });
  });

  it("keeps a status-bar entry that reopens the history", async () => {
    await open();
    await selectAndCompare([C2, C3]);
    const [item] = vscodeMock.statusBarItems;

    expect(item.isVisible).toBe(true);
    expect(item.command).toBe(OPEN_HISTORY_COMMAND);
    expect(item.text).toBe("$(git-commit) alpha: 2 selected · base 11111111");
    await send({ type: "base", ref: "main" });
    expect(item.text).toBe("$(git-commit) alpha: 2 selected · base main (33333333)");

    view.fireDidChangeVisibility(false);
    await provider.reveal();
    expect(item.isVisible).toBe(true);
    expect(vscodeMock.executedCommands.map((executed) => executed.command)).toEqual([FOCUS_HISTORY_VIEW_COMMAND]);
  });

  it("explains when no repository is found", async () => {
    provider = createProvider([]);
    view = createFakeWebviewView();
    provider.resolveWebviewView(view);
    loadDocument(view);
    await settle();

    expect(shownHtml(view)).toContain("No Git repository found in this workspace");
    expect(vscodeMock.statusBarItems[0].isVisible).toBe(false);
  });

  it("reports a missing Git executable", async () => {
    vscodeMock.workspaceFolders = [folder(ROOT_A)];
    provider = new HistoryViewProvider({
      mediaRoot: vscode.Uri.file("/extension/media"),
      fileOpener,
      log: { appendLine: (line) => void log.push(line) },
      findRepositoryRoot: () => Promise.reject(new Error("Git executable was not found.")),
    });
    view = createFakeWebviewView();
    provider.resolveWebviewView(view);
    loadDocument(view);
    await settle();

    expect(shownHtml(view)).toContain("Git executable was not found.");
  });

  it("adds a repository chosen from the folder picker", async () => {
    await open([]);
    vscodeMock.openDialogResponse = [vscode.Uri.file(ROOT_B)];

    await send({ type: "chooseRepository" });

    expect(vscodeMock.openDialogRequests[0]).toMatchObject({ canSelectFolders: true, canSelectFiles: false });
    expect(shownHtml(view)).toContain(">beta</option>");
    expect(repositories.get(ROOT_B)?.loadCount).toBe(1);
  });

  it("cancels pending comparisons and disposes adapters on dispose", async () => {
    await open();
    const repository = repositories.get(ROOT_A)!;
    repository.isCompareHeld = true;
    await selectAndCompare([C3]);

    await provider.dispose();
    repository.finishCompare();
    await settle();

    expect(repository.compareSignals[0].aborted).toBe(true);
    expect(repository.isDisposed).toBe(true);
    expect(vscodeMock.statusBarItems[0].isDisposed).toBe(true);
    expect(repository.released).toEqual([SNAPSHOT_ID]);
  });

  it("stops handling messages from a disposed view", async () => {
    await open();
    const revision = publicState(view).revision;
    view.fireDidDispose();

    view.webview.fireDidReceiveMessage({ type: "select", revision, oids: [C2], focusedOid: C2 });
    await settle();

    const recreated = createFakeWebviewView();
    provider.resolveWebviewView(recreated);
    expect(publicState(recreated).selectedOids).toEqual([]);
  });
});
