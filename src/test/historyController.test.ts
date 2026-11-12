import { describe, expect, it } from "vitest";
import { HistoryController, HistoryRequestError } from "../model/historyController";
import type {
  ComparisonRequest,
  ComparisonResult,
  FileContentResult,
  HistoryCommit,
  HistoryData,
  HistoryRepository,
  ReadyResult,
} from "../model/historyTypes";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

interface PendingCall<Input, Output> {
  readonly input: Input;
  readonly signal: AbortSignal;
  readonly reply: Deferred<Output>;
}

/** Records every port call and lets each test settle them in any order. */
class FakeRepository implements HistoryRepository {
  readonly loads: PendingCall<null, HistoryData>[] = [];
  readonly resolves: PendingCall<string, HistoryCommit>[] = [];
  readonly compares: PendingCall<ComparisonRequest, ComparisonResult>[] = [];
  readonly released: string[] = [];

  loadHistory(signal: AbortSignal): Promise<HistoryData> {
    return this.record(this.loads, null, signal);
  }

  resolveRef(ref: string, signal: AbortSignal): Promise<HistoryCommit> {
    return this.record(this.resolves, ref, signal);
  }

  compare(request: ComparisonRequest, signal: AbortSignal): Promise<ComparisonResult> {
    return this.record(this.compares, request, signal);
  }

  readFile(): Promise<FileContentResult> {
    throw new Error("not used by the controller");
  }

  releaseSnapshot(snapshotId: string): void {
    this.released.push(snapshotId);
  }

  private record<Input, Output>(calls: PendingCall<Input, Output>[], input: Input, signal: AbortSignal): Promise<Output> {
    const reply = deferred<Output>();
    calls.push({ input, signal, reply });
    return reply.promise;
  }
}

const oid = (character: string): string => character.repeat(40);
const A = oid("a");
const B = oid("b");
const C = oid("c");
const M = oid("d");

function commit(commitOid: string, parents: readonly string[]): HistoryCommit {
  return { oid: commitOid, parents, author: "Ada", authoredDate: "2026-01-01T00:00:00+00:00", subject: `commit ${commitOid[0]}` };
}

const HISTORY: HistoryData = {
  commits: [commit(M, [C, A]), commit(C, [B]), commit(B, [A]), commit(A, [])],
  refs: [{ kind: "localBranch", name: "main", oid: M }],
};

function ready(snapshotId: string, base = A): ReadyResult {
  return {
    kind: "ready",
    snapshotId,
    base: { kind: "commit", oid: base, subject: "base" },
    orderedOids: [],
    files: [{
      id: `${snapshotId}-file`,
      status: "added",
      base: null,
      result: { path: "f.txt", blob: oid("f"), mode: "100644" },
      contentKind: "text",
    }],
  };
}

async function loadedController(): Promise<{ controller: HistoryController; repository: FakeRepository }> {
  const repository = new FakeRepository();
  const controller = new HistoryController(repository);
  const loading = controller.load();
  repository.loads[0]!.reply.resolve(HISTORY);
  await loading;
  return { controller, repository };
}

/** Starts a comparison of `oids` and returns its pending port call plus completion. */
function startCompare(
  controller: HistoryController,
  repository: FakeRepository,
  oids: readonly string[],
): { call: PendingCall<ComparisonRequest, ComparisonResult>; done: Promise<void> } {
  controller.setSelection(oids);
  const done = controller.compare();
  return { call: repository.compares.at(-1)!, done };
}

describe("HistoryController loading", () => {
  it("publishes loaded metadata and advances the revision", async () => {
    const { controller } = await loadedController();

    const state = controller.getState();
    expect(state.history).toBe(HISTORY);
    expect(state.operations.isLoading).toBe(false);
    expect(state.revision).toBeGreaterThan(0);
  });

  it("keeps the last metadata and shows an error when a reload fails", async () => {
    const { controller, repository } = await loadedController();

    const reloading = controller.load();
    expect(controller.getState().operations.isLoading).toBe(true);
    repository.loads[1]!.reply.reject(new Error("git is missing"));
    await reloading;

    const state = controller.getState();
    expect(state.history).toBe(HISTORY);
    expect(state.error).toEqual({ operation: "load", message: "git is missing" });
    expect(state.operations.isLoading).toBe(false);
  });

  it("ignores a superseded load", async () => {
    const repository = new FakeRepository();
    const controller = new HistoryController(repository);

    const first = controller.load();
    const second = controller.load();
    expect(repository.loads[0]!.signal.aborted).toBe(true);
    repository.loads[1]!.reply.resolve(HISTORY);
    repository.loads[0]!.reply.resolve({ commits: [], refs: [] });
    await Promise.all([first, second]);

    expect(controller.getState().history).toBe(HISTORY);
  });
});

describe("HistoryController selection", () => {
  it("deduplicates the selection and rejects commits outside the loaded history", async () => {
    const { controller } = await loadedController();

    controller.setSelection([B, C, B]);

    expect(controller.getState().selectedOids).toEqual([B, C]);
    expect(() => controller.setSelection([oid("e")])).toThrow(HistoryRequestError);
    expect(controller.getState().selectedOids).toEqual([B, C]);
  });

  it("does not let an old response replace the comparison of a newer selection", async () => {
    const { controller, repository } = await loadedController();
    const old = startCompare(controller, repository, [B]);
    const latest = startCompare(controller, repository, [C]);

    expect(old.call.signal.aborted).toBe(true);
    latest.call.reply.resolve(ready("new"));
    old.call.reply.resolve(ready("old"));
    await Promise.all([old.done, latest.done]);

    expect(controller.getState().comparison).toEqual(ready("new"));
    expect(repository.released).toEqual(["old"]);
  });

  it("ignores a superseded comparison that fails after cancellation", async () => {
    const { controller, repository } = await loadedController();
    const old = startCompare(controller, repository, [B]);
    const latest = startCompare(controller, repository, [C]);

    old.call.reply.reject(new Error("aborted"));
    await old.done;

    const state = controller.getState();
    expect(state.error).toBeNull();
    expect(state.operations.isComparing).toBe(true);
    latest.call.reply.resolve(ready("new"));
    await latest.done;
    expect(controller.getState().comparison).toEqual(ready("new"));
  });

  it("drops the previous aggregate as soon as the selection changes", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [B]);
    first.call.reply.resolve(ready("s1"));
    await first.done;

    controller.setSelection([B, C]);

    expect(controller.getState().comparison).toBeNull();
    expect(repository.released).toEqual(["s1"]);
  });

  it("keeps the comparison when the same selection is sent again", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [B]);
    first.call.reply.resolve(ready("s1"));
    await first.done;
    const revision = controller.getState().revision;

    controller.setSelection([B]);

    expect(controller.getState().comparison).toEqual(ready("s1"));
    expect(controller.getState().revision).toBe(revision);
    expect(repository.released).toEqual([]);
  });

  it("keeps the comparison when the same selection is sent in a different order", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [B, C]);
    first.call.reply.resolve(ready("s1"));
    await first.done;

    controller.setSelection([C, B, C]);

    expect(controller.getState().comparison).toEqual(ready("s1"));
    expect(controller.getState().selectedOids).toEqual([B, C]);
    expect(repository.released).toEqual([]);
  });

  it("releases the snapshot and skips the port for an empty selection", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [B]);
    first.call.reply.resolve(ready("s1"));
    await first.done;

    controller.setSelection([]);
    await controller.compare();

    expect(repository.released).toEqual(["s1"]);
    expect(repository.compares).toHaveLength(1);
    expect(controller.getState().comparison).toBeNull();
  });

  it("releases the replaced snapshot when recomparing", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [B]);
    first.call.reply.resolve(ready("s1"));
    await first.done;

    const again = controller.compare();
    repository.compares[1]!.reply.resolve(ready("s2"));
    await again;

    expect(controller.getState().comparison).toEqual(ready("s2"));
    expect(repository.released).toEqual(["s1"]);
  });

  it("clears files when a comparison is blocked", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [B]);
    first.call.reply.resolve(ready("s1"));
    await first.done;

    const again = controller.compare();
    repository.compares[1]!.reply.resolve({
      kind: "blocked",
      base: { kind: "emptyTree" },
      orderedOids: [B],
      failingOid: B,
      paths: ["f.txt"],
      explanation: "patch does not apply",
    });
    await again;

    const comparison = controller.getState().comparison;
    expect(comparison?.kind).toBe("blocked");
    expect(comparison).not.toHaveProperty("files");
    expect(repository.released).toEqual(["s1"]);
  });

  it("reports a failed comparison without a comparison", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [B]);

    first.call.reply.reject(new Error("replay failed"));
    await first.done;

    const state = controller.getState();
    expect(state.comparison).toBeNull();
    expect(state.error).toEqual({ operation: "compare", message: "replay failed" });
    expect(state.operations.isComparing).toBe(false);
  });
});

describe("HistoryController base", () => {
  it("resolves an explicit ref once and pins its commit", async () => {
    const { controller, repository } = await loadedController();
    controller.setSelection([B, C]);

    const resolving = controller.setBase("main");
    expect(controller.getState().operations.isResolvingBase).toBe(true);
    repository.resolves[0]!.reply.resolve(commit(A, []));
    await resolving;
    const first = controller.compare();
    repository.compares[0]!.reply.resolve(ready("s1"));
    await first;
    const second = controller.compare();
    repository.compares[1]!.reply.resolve(ready("s2"));
    await second;

    expect(repository.resolves).toHaveLength(1);
    expect(repository.resolves[0]!.input).toBe("main");
    const pinned = { kind: "pinned", oid: A, label: "main" };
    expect(controller.getState().base).toEqual(pinned);
    expect(repository.compares.map((call) => call.input.base)).toEqual([pinned, pinned]);
  });

  it("asks the port to recalculate an Automatic base for each selection", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [B]);
    first.call.reply.resolve(ready("s1", A));
    await first.done;

    const second = startCompare(controller, repository, [C]);
    second.call.reply.resolve(ready("s2", B));
    await second.done;

    expect(repository.compares.map((call) => call.input.base)).toEqual([{ kind: "automatic" }, { kind: "automatic" }]);
    expect(controller.getState().comparison).toMatchObject({ base: { kind: "commit", oid: B } });
  });

  it("keeps the base and reports an error when a ref does not resolve", async () => {
    const { controller, repository } = await loadedController();

    const resolving = controller.setBase("nope");
    repository.resolves[0]!.reply.reject(new Error("unknown revision"));
    await resolving;

    const state = controller.getState();
    expect(state.base).toEqual({ kind: "automatic" });
    expect(state.error).toEqual({ operation: "resolveBase", message: "unknown revision" });
  });

  it("cancels a pending resolution when Automatic is chosen", async () => {
    const { controller, repository } = await loadedController();

    const resolving = controller.setBase("main");
    await controller.setBase(null);
    repository.resolves[0]!.reply.resolve(commit(A, []));
    await resolving;

    expect(repository.resolves[0]!.signal.aborted).toBe(true);
    expect(controller.getState().base).toEqual({ kind: "automatic" });
    expect(controller.getState().operations.isResolvingBase).toBe(false);
  });

  it("keeps the comparison when Automatic is chosen again", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [B]);
    first.call.reply.resolve(ready("s1"));
    await first.done;

    await controller.setBase(null);

    expect(controller.getState().comparison).toEqual(ready("s1"));
    expect(repository.released).toEqual([]);
  });

  it("clears a stale resolution error when Automatic is chosen", async () => {
    const { controller, repository } = await loadedController();
    const resolving = controller.setBase("nope");
    repository.resolves[0]!.reply.reject(new Error("unknown revision"));
    await resolving;

    await controller.setBase(null);

    expect(controller.getState().error).toBeNull();
  });
});

describe("HistoryController mainlines", () => {
  it("rejects parent numbers the commit does not have", async () => {
    const { controller } = await loadedController();

    for (const parentNumber of [0, 3, 1.5, Number.NaN]) {
      expect(() => controller.setMainline(M, parentNumber)).toThrow(HistoryRequestError);
    }
    expect(() => controller.setMainline(oid("e"), 1)).toThrow(HistoryRequestError);
    expect(() => controller.setMainline(B, 1)).toThrow(HistoryRequestError);
    expect(controller.getState().mainlines).toEqual([]);
  });

  it("sends choices for selected merges only and replaces earlier choices", async () => {
    const { controller, repository } = await loadedController();
    controller.setMainline(M, 1);
    controller.setMainline(M, 2);

    void startCompare(controller, repository, [B]).done;
    void startCompare(controller, repository, [M, B]).done;

    expect(controller.getState().mainlines).toEqual([{ oid: M, parentNumber: 2 }]);
    expect(repository.compares.map((call) => call.input.mainlines)).toEqual([[], [{ oid: M, parentNumber: 2 }]]);
  });

  it("discards the comparison when a parent choice changes", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [M]);
    first.call.reply.resolve(ready("s1"));
    await first.done;

    controller.setMainline(M, 2);

    expect(controller.getState().comparison).toBeNull();
    expect(repository.released).toEqual(["s1"]);
  });

  it("keeps the comparison when the same parent is chosen again", async () => {
    const { controller, repository } = await loadedController();
    controller.setMainline(M, 2);
    const first = startCompare(controller, repository, [M]);
    first.call.reply.resolve(ready("s1"));
    await first.done;

    controller.setMainline(M, 2);

    expect(controller.getState().comparison).toEqual(ready("s1"));
    expect(repository.released).toEqual([]);
  });
});

describe("HistoryController lifecycle", () => {
  it("cancels pending work on dispose and releases late snapshots", async () => {
    const { controller, repository } = await loadedController();
    const reloading = controller.load();
    const resolving = controller.setBase("main");
    const pending = startCompare(controller, repository, [B]);

    controller.dispose();
    pending.call.reply.resolve(ready("late"));
    repository.resolves[0]!.reply.resolve(commit(A, []));
    repository.loads[1]!.reply.resolve({ commits: [], refs: [] });
    await Promise.all([reloading, resolving, pending.done]);

    expect(repository.loads[1]!.signal.aborted).toBe(true);
    expect(repository.resolves[0]!.signal.aborted).toBe(true);
    expect(pending.call.signal.aborted).toBe(true);
    expect(repository.released).toEqual(["late"]);
    expect(controller.getState().operations).toEqual({ isLoading: false, isResolvingBase: false, isComparing: false });
    expect(() => controller.setSelection([])).toThrow(HistoryRequestError);
  });

  it("releases the current snapshot on dispose", async () => {
    const { controller, repository } = await loadedController();
    const first = startCompare(controller, repository, [B]);
    first.call.reply.resolve(ready("s1"));
    await first.done;

    controller.dispose();

    expect(repository.released).toEqual(["s1"]);
  });

  it("keeps every state serializable", async () => {
    const { controller, repository } = await loadedController();
    const states = [controller.getState()];
    const pinning = controller.setBase("main");
    states.push(controller.getState());
    repository.resolves[0]!.reply.resolve(commit(A, []));
    await pinning;
    controller.setMainline(M, 2);
    const pending = startCompare(controller, repository, [M, B]);
    states.push(controller.getState());
    pending.call.reply.resolve(ready("s1"));
    await pending.done;
    states.push(controller.getState());

    for (const state of states) {
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    }
  });
});
