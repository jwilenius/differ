import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitComparisonRepository, HistorySnapshotError } from "../git/gitComparisonRepository";
import { HistoryController } from "../model/historyController";
import type { BaseSelection, ComparisonResult, ReadyResult } from "../model/historyTypes";
import {
  commitFiles,
  createHistoryRepository,
  disposeHistoryRepository,
  fixtureGitEnvironment,
  runFixtureGit,
} from "./gitHistoryFixture";
import type { HistoryRepositoryFixture } from "./gitHistoryFixture";

/** While set, every file listing (`listing`) or content read (`content`) waits for it before doing real work. */
const gates = vi.hoisted(() => ({ listing: null as Promise<void> | null, content: null as Promise<void> | null }));

vi.mock("../git/gitComparisonFiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git/gitComparisonFiles")>();
  return {
    ...actual,
    readComparisonFiles: async (...args: Parameters<typeof actual.readComparisonFiles>) => {
      await gates.listing;
      return actual.readComparisonFiles(...args);
    },
    readComparisonFile: async (...args: Parameters<typeof actual.readComparisonFile>) => {
      await gates.content;
      return actual.readComparisonFile(...args);
    },
  };
});

const signal = new AbortController().signal;
const AUTOMATIC: BaseSelection = { kind: "automatic" };

describe("GitComparisonRepository", () => {
  let fixture: HistoryRepositoryFixture;
  let temporaryParent: string;
  let repository: GitComparisonRepository;

  beforeEach(() => {
    fixture = createHistoryRepository();
    temporaryParent = path.join(fixture.directory, "tmp");
    fs.mkdirSync(temporaryParent);
    repository = new GitComparisonRepository(fixture.root, { env: fixtureGitEnvironment(), temporaryParent });
  });

  afterEach(async () => {
    gates.listing = null;
    gates.content = null;
    await repository.dispose();
    disposeHistoryRepository(fixture);
  });

  function commit(name: string, content = `${name}\n`): string {
    return commitFiles(fixture.root, {
      message: name,
      changes: [{ kind: "write", path: `${name}.txt`, content }],
    });
  }

  /** Main: A, B, C, D, each adding its own file. */
  function linearHistory(): readonly [string, string, string, string] {
    return [commit("a"), commit("b"), commit("c"), commit("d")];
  }

  function compare(selectedOids: readonly string[], base = AUTOMATIC): Promise<ComparisonResult> {
    return repository.compare({ selectedOids, base, mainlines: [] }, signal);
  }

  async function compareReady(selectedOids: readonly string[]): Promise<ReadyResult> {
    const result = await compare(selectedOids);
    if (result.kind !== "ready") {
      throw new Error(`Expected a ready comparison, got ${result.kind}.`);
    }
    return result;
  }

  function fileId(result: ReadyResult, filePath: string): string {
    const file = result.files.find((candidate) => candidate.result?.path === filePath);
    if (file === undefined) {
      throw new Error(`No file row for ${filePath}.`);
    }
    return file.id;
  }

  /** Holds the gated operation until the returned function is called. */
  function closeGate(gate: keyof typeof gates): () => void {
    let open = (): void => undefined;
    gates[gate] = new Promise((resolve) => {
      open = resolve;
    });
    return open;
  }

  /** Lets in-flight Git processes and callbacks run. */
  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
  }

  function privateDirectories(): readonly string[] {
    return fs.readdirSync(temporaryParent);
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => null,
      (reason: unknown) => reason,
    );
  }

  async function expectSnapshotError(promise: Promise<unknown>, kind: HistorySnapshotError["kind"]): Promise<void> {
    const error = await rejection(promise);
    expect(error).toBeInstanceOf(HistorySnapshotError);
    expect((error as HistorySnapshotError).kind).toBe(kind);
  }

  it("compares real commits and reads their file content", async () => {
    const [a, b, , d] = linearHistory();

    const result = await compareReady([d, b]);
    const content = await repository.readFile(result.snapshotId, fileId(result, "b.txt"), "result", signal);

    expect(result.base).toEqual({ kind: "commit", oid: a, subject: "a" });
    expect(result.orderedOids).toEqual([b, d]);
    expect(result.files.map((file) => file.result?.path)).toEqual(["b.txt", "d.txt"]);
    expect(content).toEqual({ kind: "text", text: "b\n" });
  });

  it("returns a blocked comparison without a snapshot", async () => {
    const a = commitFiles(fixture.root, { message: "A", changes: [{ kind: "write", path: "f.txt", content: "1\n" }] });
    commitFiles(fixture.root, { message: "B", changes: [{ kind: "write", path: "f.txt", content: "2\n" }] });
    const c = commitFiles(fixture.root, { message: "C", changes: [{ kind: "write", path: "f.txt", content: "3\n" }] });

    const result = await compare([c], { kind: "pinned", oid: a, label: "A" });

    expect(result).toMatchObject({ kind: "blocked", failingOid: c, paths: ["f.txt"], orderedOids: [c] });
    expect(result).not.toHaveProperty("snapshotId");
    expect(privateDirectories()).toEqual([]);
  });

  it("passes a request needing a base through without replaying", async () => {
    commit("a");
    runFixtureGit(fixture.root, ["switch", "-q", "-c", "side"]);
    const left = commit("left");
    runFixtureGit(fixture.root, ["switch", "-q", "main"]);
    const right = commit("right");

    const result = await compare([left, right]);

    expect(result.kind).toBe("needsBase");
    expect(result.kind === "needsBase" && [...result.minimumOids].sort()).toEqual([left, right].sort());
    expect(privateDirectories()).toEqual([]);
  });

  it("rejects unknown snapshots and files", async () => {
    const [, b] = linearHistory();
    const result = await compareReady([b]);

    await expectSnapshotError(repository.readFile("missing", result.files[0]!.id, "base", signal), "unknownSnapshot");
    await expectSnapshotError(repository.readFile(result.snapshotId, "missing", "base", signal), "unknownFile");
  });

  it("keeps a released snapshot until its active read finishes", async () => {
    const [, b] = linearHistory();
    const result = await compareReady([b]);
    const openGate = closeGate("content");

    const read = repository.readFile(result.snapshotId, fileId(result, "b.txt"), "result", signal);
    repository.releaseSnapshot(result.snapshotId);
    await settle();

    expect(privateDirectories()).toHaveLength(1);
    const laterRead = repository.readFile(result.snapshotId, result.files[0]!.id, "base", signal);
    await expectSnapshotError(laterRead, "unknownSnapshot");
    openGate();
    expect(await read).toEqual({ kind: "text", text: "b\n" });
    await vi.waitFor(() => expect(privateDirectories()).toEqual([]));
  });

  it("treats repeated release as harmless", async () => {
    const [, b] = linearHistory();
    const result = await compareReady([b]);

    repository.releaseSnapshot(result.snapshotId);
    repository.releaseSnapshot(result.snapshotId);
    repository.releaseSnapshot("never-issued");

    await vi.waitFor(() => expect(privateDirectories()).toEqual([]));
  });

  it("cleans up a comparison cancelled by its caller", async () => {
    const [, b, , d] = linearHistory();
    const controller = new AbortController();
    const watcher = fs.watch(temporaryParent, () => controller.abort());

    try {
      const request = { selectedOids: [b, d], base: AUTOMATIC, mainlines: [] };
      const error = await rejection(repository.compare(request, controller.signal));

      expect(error).toBeInstanceOf(Error);
      expect(privateDirectories()).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it("deletes every snapshot on dispose, including one finishing afterwards, and rejects later calls", async () => {
    const [, b, , d] = linearHistory();
    await compareReady([b]);
    const pending = rejection(compare([d]));

    await repository.dispose();

    expect(await pending).toBeInstanceOf(Error);
    expect(privateDirectories()).toEqual([]);
    await expectSnapshotError(compare([b]), "disposed");
    await expectSnapshotError(repository.loadHistory(signal), "disposed");
  });

  it("deletes a replay whose files are still being listed when disposed", async () => {
    const [, b] = linearHistory();
    const openGate = closeGate("listing");
    const pending = rejection(compare([b]));
    await vi.waitFor(() => expect(privateDirectories()).toHaveLength(1));

    const disposal = repository.dispose();
    openGate();
    await disposal;

    expect(await pending).toBeInstanceOf(Error);
    expect(privateDirectories()).toEqual([]);
  });

  it("waits for an active read before deleting its snapshot on dispose", async () => {
    const [, b] = linearHistory();
    const result = await compareReady([b]);
    const openGate = closeGate("content");
    const read = rejection(repository.readFile(result.snapshotId, fileId(result, "b.txt"), "result", signal));
    await settle();

    const disposal = repository.dispose();
    await settle();
    expect(privateDirectories()).toHaveLength(1);
    openGate();
    await disposal;

    expect(await read).toBeInstanceOf(Error);
    expect(privateDirectories()).toEqual([]);
  });

  it("runs the history controller end to end and leaves no private files behind", async () => {
    const [, b, c, d] = linearHistory();
    const controller = new HistoryController(repository);
    await controller.load();

    controller.setSelection([b, d]);
    await controller.compare();
    const first = controller.getState().comparison;
    controller.setSelection([c]);
    await controller.compare();
    const second = controller.getState().comparison;

    expect(first?.kind).toBe("ready");
    expect(second).toMatchObject({ kind: "ready", orderedOids: [c] });
    await expectSnapshotError(
      repository.readFile((first as ReadyResult).snapshotId, (first as ReadyResult).files[0]!.id, "base", signal),
      "unknownSnapshot",
    );
    expect(privateDirectories()).toHaveLength(1);

    controller.dispose();
    await vi.waitFor(() => expect(privateDirectories()).toEqual([]));
  });
});
