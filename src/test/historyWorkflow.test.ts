import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitComparisonRepository } from "../git/gitComparisonRepository";
import { HistoryController } from "../model/historyController";
import type {
  BlockedResult,
  ComparisonFile,
  ComparisonResult,
  FileContentResult,
  NeedsBaseResult,
  ReadyResult,
} from "../model/historyTypes";
import {
  captureRepositoryState,
  commitFiles,
  createHistoryRepository,
  disposeHistoryRepository,
  fixtureGitEnvironment,
  runFixtureGit,
} from "./gitHistoryFixture";
import type { FixtureFileChange, HistoryRepositoryFixture, RepositoryState } from "./gitHistoryFixture";

const signal = new AbortController().signal;

interface FileSides {
  readonly base: FileContentResult;
  readonly result: FileContentResult;
}

/**
 * The real workflow without mocking Git: controller → Git adapter → replay → changed files → both content sides.
 * Every test also checks that the source repository is left byte-for-byte unchanged.
 */
describe("history workflow", () => {
  let fixture: HistoryRepositoryFixture;
  let temporaryParent: string;
  let repository: GitComparisonRepository;
  let controller: HistoryController;
  let sourceBefore: RepositoryState;

  beforeEach(() => {
    fixture = createHistoryRepository();
    temporaryParent = path.join(fixture.directory, "tmp");
    fs.mkdirSync(temporaryParent);
    repository = new GitComparisonRepository(fixture.root, { env: fixtureGitEnvironment(), temporaryParent });
    controller = new HistoryController(repository);
  });

  afterEach(async () => {
    controller.dispose();
    await repository.dispose();
    expect(fs.readdirSync(temporaryParent)).toEqual([]);
    disposeHistoryRepository(fixture);
  });

  function write(filePath: string, content: string): FixtureFileChange {
    return { kind: "write", path: filePath, content };
  }

  function commit(message: string, ...changes: readonly FixtureFileChange[]): string {
    return commitFiles(fixture.root, { message, changes });
  }

  function git(...args: readonly string[]): string {
    return runFixtureGit(fixture.root, args).trim();
  }

  /** Captures the source state, then loads history as the panel would. */
  async function openHistory(): Promise<void> {
    sourceBefore = captureRepositoryState(fixture.root);
    await controller.load();
    expect(controller.getState().error).toBeNull();
  }

  function expectSourceUnchanged(): void {
    expect(captureRepositoryState(fixture.root)).toEqual(sourceBefore);
  }

  async function compareSelection(oids: readonly string[]): Promise<ComparisonResult | null> {
    controller.setSelection(oids);
    await controller.compare();
    return controller.getState().comparison;
  }

  function expectReady(comparison: ComparisonResult | null): ReadyResult {
    expect(controller.getState().error).toBeNull();
    expect(comparison?.kind).toBe("ready");
    return comparison as ReadyResult;
  }

  function changedPaths(result: ReadyResult): readonly string[] {
    return result.files.map((file) => (file.result ?? file.base)?.path ?? "");
  }

  function fileAt(result: ReadyResult, filePath: string): ComparisonFile {
    const file = result.files.find((candidate) => (candidate.result ?? candidate.base)?.path === filePath);
    if (file === undefined) {
      throw new Error(`No file row for ${filePath}.`);
    }
    return file;
  }

  /** Reads both sides together, as the host does before opening a diff. */
  async function readSides(result: ReadyResult, file: ComparisonFile): Promise<FileSides> {
    const [base, sideResult] = await Promise.all([
      repository.readFile(result.snapshotId, file.id, "base", signal),
      repository.readFile(result.snapshotId, file.id, "result", signal),
    ]);
    return { base, result: sideResult };
  }

  function text(content: string): FileContentResult {
    return { kind: "text", text: content };
  }

  it("replays only the selected subset, excluding the omitted middle commit", async () => {
    const a = commit("A", write("a.txt", "a\n"));
    const b = commit("B", write("b.txt", "b\n"));
    commit("C", write("c.txt", "c\n"));
    const d = commit("D", write("d.txt", "d\n"));
    fs.writeFileSync(path.join(fixture.root, "untracked.txt"), "dirty\n");
    await openHistory();

    const result = expectReady(await compareSelection([d, b]));

    expect(result.base).toEqual({ kind: "commit", oid: a, subject: "A" });
    expect(result.orderedOids).toEqual([b, d]);
    expect(changedPaths(result)).toEqual(["b.txt", "d.txt"]);
    expect(result.files.map((file) => file.status)).toEqual(["added", "added"]);
    expect(await readSides(result, fileAt(result, "b.txt"))).toEqual({ base: text(""), result: text("b\n") });
    expect(await readSides(result, fileAt(result, "d.txt"))).toEqual({ base: text(""), result: text("d\n") });
    expectSourceUnchanged();
  });

  it("requires an explicit base for sibling commits, then aggregates their independent files", async () => {
    const a = commit("A", write("shared.txt", "shared\n"));
    git("tag", "start");
    git("switch", "-q", "-c", "side");
    const left = commit("Left", write("left.txt", "left\n"));
    git("switch", "-q", "main");
    const right = commit("Right", write("right.txt", "right\n"));
    await openHistory();

    const needsBase = (await compareSelection([left, right])) as NeedsBaseResult;
    expect(needsBase.kind).toBe("needsBase");
    expect([...needsBase.minimumOids].sort()).toEqual([left, right].sort());

    await controller.setBase("start");
    expect(controller.getState().base).toEqual({ kind: "pinned", oid: a, label: "start" });
    await controller.compare();
    const result = expectReady(controller.getState().comparison);

    expect(result.base).toEqual({ kind: "commit", oid: a, subject: "A" });
    expect([...result.orderedOids].sort()).toEqual([left, right].sort());
    expect(changedPaths(result)).toEqual(["left.txt", "right.txt"]);
    expect(await readSides(result, fileAt(result, "left.txt"))).toEqual({ base: text(""), result: text("left\n") });
    expect(await readSides(result, fileAt(result, "right.txt"))).toEqual({ base: text(""), result: text("right\n") });
    expectSourceUnchanged();
  });

  it("blocks an incompatible edit and leaves no completed files", async () => {
    const a = commit("A", write("f.txt", "1\n"));
    commit("B", write("f.txt", "2\n"));
    const c = commit("C", write("f.txt", "3\n"));
    await openHistory();

    await controller.setBase(a);
    const blocked = (await compareSelection([c])) as BlockedResult;

    expect(blocked.kind).toBe("blocked");
    expect(blocked).toMatchObject({ failingOid: c, paths: ["f.txt"], orderedOids: [c] });
    expect(blocked).not.toHaveProperty("files");
    expect(blocked).not.toHaveProperty("snapshotId");
    expect(fs.readdirSync(temporaryParent)).toEqual([]);
    expectSourceUnchanged();
  });

  it("opens the old and new contents of a renamed file", async () => {
    const original = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    const edited = "line 1\nline 2\nline 3\nline 4\nline five\n";
    commit("A", write("old name.txt", original));
    git("mv", "old name.txt", "new name.txt");
    const rename = commit("Rename", write("new name.txt", edited));
    await openHistory();

    const result = expectReady(await compareSelection([rename]));
    const file = fileAt(result, "new name.txt");

    expect(result.files).toHaveLength(1);
    expect(file.status).toBe("renamed");
    expect(file.base?.path).toBe("old name.txt");
    expect(await readSides(result, file)).toEqual({ base: text(original), result: text(edited) });
    expectSourceUnchanged();
  });

  it("shows no files when the selected changes cancel out", async () => {
    commit("A", write("a.txt", "a\n"));
    const add = commit("Add", write("temp.txt", "temp\n"));
    const remove = commitFiles(fixture.root, { message: "Remove", changes: [{ kind: "delete", path: "temp.txt" }] });
    await openHistory();

    const result = expectReady(await compareSelection([remove, add]));

    expect(result.orderedOids).toEqual([add, remove]);
    expect(result.files).toEqual([]);
    expectSourceUnchanged();
  });

  it("takes a merge's patch and Automatic base from the chosen mainline parent", async () => {
    commit("A", write("a.txt", "a\n"));
    git("switch", "-q", "-c", "side");
    const side = commit("Side", write("side.txt", "side\n"));
    git("switch", "-q", "main");
    const mainParent = commit("Main", write("main.txt", "main\n"));
    git("merge", "-q", "--no-ff", "--no-edit", "side");
    const merge = git("rev-parse", "HEAD");
    await openHistory();

    const first = expectReady(await compareSelection([merge]));
    controller.setMainline(merge, 2);
    await controller.compare();
    const second = expectReady(controller.getState().comparison);

    expect(first.base).toMatchObject({ kind: "commit", oid: mainParent });
    expect(changedPaths(first)).toEqual(["side.txt"]);
    expect(second.base).toMatchObject({ kind: "commit", oid: side });
    expect(changedPaths(second)).toEqual(["main.txt"]);
    expect(await readSides(second, fileAt(second, "main.txt"))).toEqual({ base: text(""), result: text("main\n") });
    await expect(repository.readFile(first.snapshotId, first.files[0]!.id, "result", signal)).rejects.toThrow();
    expectSourceUnchanged();
  });

  it("discards a comparison superseded mid-flight and keeps only the current snapshot", async () => {
    commit("A", write("a.txt", "a\n"));
    const b = commit("B", write("b.txt", "b\n"));
    commit("C", write("c.txt", "c\n"));
    const d = commit("D", write("d.txt", "d\n"));
    await openHistory();

    controller.setSelection([b, d]);
    const cancelled = controller.compare();
    controller.setSelection([b]);
    await controller.compare();
    await cancelled;

    const result = expectReady(controller.getState().comparison);
    expect(result.orderedOids).toEqual([b]);
    expect(changedPaths(result)).toEqual(["b.txt"]);
    expect(controller.getState().operations.isComparing).toBe(false);
    await vi.waitFor(() => expect(fs.readdirSync(temporaryParent)).toHaveLength(1));
    expectSourceUnchanged();
  });
});
