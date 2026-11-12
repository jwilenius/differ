import { randomUUID } from "node:crypto";
import type {
  BlockedResult,
  ComparisonFile,
  ComparisonRequest,
  ComparisonResult,
  FileContentResult,
  FileSide,
  HistoryCommit,
  HistoryData,
  HistoryRepository,
  ReadyResult,
} from "../model/historyTypes";
import { readComparisonFile, readComparisonFiles } from "./gitComparisonFiles";
import { GitHistoryRepository } from "./gitHistoryRepository";
import { resolveHistoryComparison } from "./historyComparisonResolver";
import type { ResolvedHistoryComparison } from "./historyComparisonResolver";
import { replaySelection } from "./gitSelectionReplay";
import type { ReplayBlockedResult, ReplayOptions, ReplaySession } from "./gitSelectionReplay";

/** The replay options, which already cover reading the source repository and deleting released snapshots. */
export type GitComparisonRepositoryOptions = ReplayOptions;

export type HistorySnapshotErrorKind = "unknownSnapshot" | "unknownFile" | "disposed";

/** A file read naming a snapshot or file this adapter does not (or no longer) hold, or a call after `dispose`. */
export class HistorySnapshotError extends Error {
  constructor(
    message: string,
    readonly kind: HistorySnapshotErrorKind,
  ) {
    super(message);
    this.name = "HistorySnapshotError";
  }
}

/** A registered replay; `leaseCount` reads are in flight, and a released snapshot is deleted once they finish. */
interface Snapshot {
  readonly session: ReplaySession;
  readonly filesById: ReadonlyMap<string, ComparisonFile>;
  leaseCount: number;
  isReleased: boolean;
}

/**
 * The Git implementation of the history port for one repository. Owns every replay snapshot it returns: private
 * paths and environments never leave this class, and each snapshot lives until released or until `dispose`.
 */
export class GitComparisonRepository implements HistoryRepository {
  private readonly history: GitHistoryRepository;
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly shutdown = new AbortController();
  /** Operations and cleanups still running, so `dispose` can wait for every private directory to go. */
  private readonly pending = new Set<Promise<unknown>>();

  /** @param root Any directory inside the repository's working tree. */
  constructor(
    private readonly root: string,
    private readonly options: GitComparisonRepositoryOptions = {},
  ) {
    this.history = new GitHistoryRepository(root, options.env);
  }

  loadHistory(signal: AbortSignal): Promise<HistoryData> {
    return this.run(signal, (linked) => this.history.loadHistory(linked));
  }

  resolveRef(ref: string, signal: AbortSignal): Promise<HistoryCommit> {
    return this.run(signal, (linked) => this.history.resolveRef(ref, linked));
  }

  /** Resolves, replays and projects files; a ready result's snapshot must later be released. */
  compare(request: ComparisonRequest, signal: AbortSignal): Promise<ComparisonResult> {
    return this.run(signal, (linked) => this.compareLinked(request, linked));
  }

  readFile(snapshotId: string, fileId: string, side: FileSide, signal: AbortSignal): Promise<FileContentResult> {
    return this.run(signal, (linked) => this.readLeased(snapshotId, fileId, side, linked));
  }

  releaseSnapshot(snapshotId: string): void {
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot === undefined) {
      return;
    }
    this.snapshots.delete(snapshotId);
    snapshot.isReleased = true;
    this.deleteIfUnused(snapshot);
  }

  /**
   * Cancels running work, releases every snapshot and resolves once all private files are deleted. Later calls
   * reject with a `disposed` error; repeated disposal is harmless.
   */
  async dispose(): Promise<void> {
    this.shutdown.abort();
    for (const snapshotId of [...this.snapshots.keys()]) {
      this.releaseSnapshot(snapshotId);
    }
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /**
   * Takes a read lease before any I/O and holds it until the content has been read, so a release cannot delete the
   * snapshot mid-read.
   */
  private async readLeased(
    snapshotId: string,
    fileId: string,
    side: FileSide,
    signal: AbortSignal,
  ): Promise<FileContentResult> {
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot === undefined) {
      throw new HistorySnapshotError("This comparison is no longer available.", "unknownSnapshot");
    }
    const file = snapshot.filesById.get(fileId);
    if (file === undefined) {
      throw new HistorySnapshotError("This file is not part of the comparison.", "unknownFile");
    }

    snapshot.leaseCount += 1;
    try {
      return await readComparisonFile(snapshot.session, file, side, signal);
    } finally {
      snapshot.leaseCount -= 1;
      this.deleteIfUnused(snapshot);
    }
  }

  private async compareLinked(request: ComparisonRequest, signal: AbortSignal): Promise<ComparisonResult> {
    const resolution = await resolveHistoryComparison(this.history, request, signal);
    if (resolution.kind === "needsBase") {
      return resolution;
    }

    const replay = await replaySelection(this.root, resolution, signal, this.options);
    if (replay.kind === "blocked") {
      return blockedResult(resolution, replay);
    }
    return this.register(replay.session, resolution, signal);
  }

  /** Projects the files and registers the snapshot; the session is deleted instead if anything fails first. */
  private async register(
    session: ReplaySession,
    resolution: ResolvedHistoryComparison,
    signal: AbortSignal,
  ): Promise<ReadyResult> {
    let files: readonly ComparisonFile[];
    try {
      files = await readComparisonFiles(session, signal);
    } catch (error) {
      this.deleteSession(session);
      throw error;
    }
    if (this.shutdown.signal.aborted) {
      this.deleteSession(session);
      throw disposedError();
    }

    const snapshotId = randomUUID();
    const filesById = new Map(files.map((file) => [file.id, file]));
    this.snapshots.set(snapshotId, { session, filesById, leaseCount: 0, isReleased: false });
    return { kind: "ready", snapshotId, base: resolution.base, orderedOids: orderedOids(resolution), files };
  }

  private deleteIfUnused(snapshot: Snapshot): void {
    const isUnused = snapshot.isReleased && snapshot.leaseCount === 0;
    if (isUnused) {
      this.deleteSession(snapshot.session);
    }
  }

  private deleteSession(session: ReplaySession): void {
    const cleanup = session.dispose().catch((error: unknown) => this.options.onCleanupError?.(error));
    void this.track(cleanup);
  }

  /** Runs work that `dispose` cancels and waits for; rejects without starting once disposed. */
  private run<T>(signal: AbortSignal, operation: (linked: AbortSignal) => Promise<T>): Promise<T> {
    return this.track(this.runLinked(signal, operation));
  }

  /** Links the signals by hand and unlinks them afterwards, so the long-lived shutdown signal keeps no listeners. */
  private async runLinked<T>(signal: AbortSignal, operation: (linked: AbortSignal) => Promise<T>): Promise<T> {
    if (this.shutdown.signal.aborted) {
      throw disposedError();
    }

    const linked = new AbortController();
    const abort = (): void => linked.abort();
    const sources = [signal, this.shutdown.signal];
    sources.forEach((source) => source.addEventListener("abort", abort, { once: true }));
    if (signal.aborted) {
      linked.abort();
    }

    try {
      return await operation(linked.signal);
    } finally {
      sources.forEach((source) => source.removeEventListener("abort", abort));
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return operation;
  }
}

function blockedResult(resolution: ResolvedHistoryComparison, replay: ReplayBlockedResult): BlockedResult {
  const { failingOid, paths, explanation } = replay;
  const { base } = resolution;
  return { kind: "blocked", base, orderedOids: orderedOids(resolution), failingOid, paths, explanation };
}

function orderedOids(resolution: ResolvedHistoryComparison): readonly string[] {
  return resolution.steps.map((step) => step.oid);
}

function disposedError(): HistorySnapshotError {
  return new HistorySnapshotError("The Git history repository has been closed.", "disposed");
}
