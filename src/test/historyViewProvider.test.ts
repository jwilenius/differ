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
  ReadyResult,
} from "../model/historyTypes";
import type { HistoryPublicState } from "../render/html/historyRenderer";
import { changeWorkspaceFolders, createFakeWebviewView, resetVscodeMock, vscodeMock } from "./vscodeMock";
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
};

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
  readonly resolvedRefs: string[] = [];
  readonly compareRequests: ComparisonRequest[] = [];
  readonly compareSignals: AbortSignal[] = [];
  readonly released: string[] = [];
  isDisposed = false;
  isCompareHeld = false;
  private heldCompares: (() => void)[] = [];

  constructor(private history: HistoryData = HISTORY) {}

  setHistory(history: HistoryData): void {
    this.history = history;
  }

  loadHistory(): Promise<HistoryData> {
    this.loadCount += 1;
    return Promise.resolve(this.history);
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

function publicState(view: FakeWebviewView): HistoryPublicState {
  const match = /data-history="([^"]*)"/.exec(view.webview.html);
  return JSON.parse(decodeHtml(match![1])) as HistoryPublicState;
}

function folder(fsPath: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(fsPath), name: fsPath, index: 0 };
}

describe("HistoryViewProvider", () => {
  let repositories: Map<string, FakeRepository>;
  let fileOpener: HistoryFileOpener & { calls: unknown[][] };
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
        const repository = new FakeRepository();
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
    await settle();
  }

  async function send(message: Record<string, unknown>): Promise<void> {
    view.webview.fireDidReceiveMessage({ revision: publicState(view).revision, ...message });
    await settle();
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
    log = [];
    fileOpener = {
      calls: [],
      openFile(...args) {
        this.calls.push(args);
        return Promise.resolve();
      },
    };
  });

  afterEach(async () => {
    await provider.dispose();
    vi.useRealTimers();
  });

  it("configures the webview and publishes the discovered repository's history", async () => {
    await open();

    expect(view.webview.options).toEqual({ enableScripts: true, localResourceRoots: [vscode.Uri.file("/extension/media")] });
    expect(view.webview.html).toContain("Third change");
    expect(view.webview.html).toContain("history.js");
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
    const betaId = /<option value="([^"]+)">beta<\/option>/.exec(view.webview.html)![1];
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
      branchOid: null,
      focusedOid: C3,
      rowLimit: 200,
    });
    await settle();

    expect(publicState(view)).toMatchObject({ focusedOid: C3, search: "" });
  });

  it("ignores a stale presentation from another repository's page", async () => {
    await open([ROOT_A, ROOT_B]);
    const alphaRevision = publicState(view).revision;
    const betaId = /<option value="([^"]+)">beta<\/option>/.exec(view.webview.html)![1];
    await send({ type: "repository", repositoryId: betaId });

    view.webview.fireDidReceiveMessage({ type: "presentation", revision: alphaRevision, search: "", branchOid: null, focusedOid: C3, rowLimit: 200 });
    await settle();

    expect(publicState(view)).toMatchObject({ repositoryId: betaId, focusedOid: null });
  });

  it("does not republish a selection or presentation that changes nothing", async () => {
    await open();
    await send({ type: "select", oids: [C2, C3], focusedOid: C3 });
    await send({ type: "presentation", search: "", branchOid: null, focusedOid: C3, rowLimit: 200 });
    const revision = publicState(view).revision;

    await send({ type: "select", oids: [C3, C2], focusedOid: C3 });
    await send({ type: "presentation", search: "", branchOid: null, focusedOid: C3, rowLimit: 200 });

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

    expect(view.webview.html).toContain(">beta</option>");
    expect(publicState(view)).toMatchObject({ repositoryId: alphaId, selectedOids: [C2] });
    expect(repositories.get(ROOT_A)?.loadCount).toBe(1);
  });

  it("finds repositories added to the workspace on refresh", async () => {
    await open([]);
    vscodeMock.workspaceFolders = [folder(ROOT_B)];

    await send({ type: "refresh" });

    expect(view.webview.html).toContain(">beta</option>");
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

    changeWorkspaceFolders([folder(ROOT_A), folder(ROOT_B)]);
    releaseFirst();
    await settle();

    expect(lookups).toEqual([ROOT_A, ROOT_A, ROOT_B]);
    expect(view.webview.html).toContain(">beta</option>");
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

  it("republishes on ready only for a revision it has not published", async () => {
    await open();
    const revision = publicState(view).revision;

    view.webview.fireDidReceiveMessage({ type: "ready", revision });
    view.webview.fireDidReceiveMessage({ type: "ready", revision: revision - 1 });
    expect(publicState(view).revision).toBe(revision);

    view.webview.fireDidReceiveMessage({ type: "ready", revision: revision + 5 });
    expect(publicState(view).revision).toBe(revision + 1);
  });

  it("accepts a selection from a document older only by presentation changes", async () => {
    await open();
    const olderRevision = publicState(view).revision;
    await send({ type: "presentation", search: "", branchOid: null, focusedOid: C3, rowLimit: 200 });

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
    await send({ type: "presentation", search: "", branchOid: F1, focusedOid: F1, rowLimit: 200 });
    const repository = repositories.get(ROOT_A)!;
    repository.setHistory({ commits: HISTORY.commits.filter((candidate) => candidate.oid !== F1), refs: HISTORY.refs.slice(0, 1) });

    await send({ type: "refresh" });
    expect(publicState(view)).toMatchObject({ focusedOid: null, branchOid: null });
    await send({ type: "presentation", search: "second", branchOid: null, focusedOid: null, rowLimit: 200 });

    expect(publicState(view).renderedOids).toEqual([C2]);
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
    await send({ type: "presentation", search: "change", branchOid: null, focusedOid: C3, rowLimit: 200 });

    view.fireDidDispose();
    const recreated = createFakeWebviewView();
    provider.resolveWebviewView(recreated);
    await settle();

    expect(publicState(recreated)).toMatchObject({ selectedOids: [C2, C3], search: "change", focusedOid: C3, snapshotId: SNAPSHOT_ID });
    expect(repositories.get(ROOT_A)?.loadCount).toBe(1);
  });

  it("keeps each repository's state separate when switching", async () => {
    await open([ROOT_A, ROOT_B]);
    await send({ type: "select", oids: [C2], focusedOid: C2 });
    const alphaId = publicState(view).repositoryId;
    const betaId = /<option value="([^"]+)">beta<\/option>/.exec(view.webview.html)![1];

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

    await send({ type: "presentation", search: "THIRD", branchOid: null, focusedOid: C2, rowLimit: 200 });
    expect(publicState(view)).toMatchObject({ renderedOids: [C3], selectedOids: [C2], search: "THIRD" });
    expect(view.webview.html).toContain("1 hidden by filters");

    await send({ type: "presentation", search: "", branchOid: F1, focusedOid: C2, rowLimit: 200 });
    expect(publicState(view)).toMatchObject({ renderedOids: [F1, C1], selectedOids: [C2], branchOid: F1 });

    await send({ type: "presentation", search: "333", branchOid: null, focusedOid: C2, rowLimit: 200 });
    expect(publicState(view).renderedOids).toEqual([C3]);
  });

  it("keeps a pinned base on refresh and deselects commits that disappeared", async () => {
    await open();
    await send({ type: "select", oids: [C3, F1], focusedOid: C3 });
    await send({ type: "base", ref: "main" });
    const repository = repositories.get(ROOT_A)!;
    repository.setHistory({ commits: HISTORY.commits.filter((candidate) => candidate.oid !== F1), refs: HISTORY.refs.slice(0, 1) });

    await send({ type: "refresh" });

    expect(repository.loadCount).toBe(2);
    expect(repository.resolvedRefs).toEqual(["main"]);
    expect(publicState(view).selectedOids).toEqual([C3]);
    expect(view.webview.html).toContain("base-pinned\">main</span>");
    expect(vscodeMock.messages.map((message) => message.text)).toEqual([
      "1 selected commit(s) are no longer in the history of alpha; they were deselected.",
    ]);
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
    await settle();

    expect(view.webview.html).toContain("No Git repository found in this workspace");
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
    await settle();

    expect(view.webview.html).toContain("Git executable was not found.");
  });

  it("adds a repository chosen from the folder picker", async () => {
    await open([]);
    vscodeMock.openDialogResponse = [vscode.Uri.file(ROOT_B)];

    await send({ type: "chooseRepository" });

    expect(vscodeMock.openDialogRequests[0]).toMatchObject({ canSelectFolders: true, canSelectFiles: false });
    expect(view.webview.html).toContain(">beta</option>");
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
