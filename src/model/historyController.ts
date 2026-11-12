import type {
  BaseSelection,
  ComparisonRequest,
  ComparisonResult,
  HistoryCommit,
  HistoryError,
  HistoryOperation,
  HistoryRepository,
  HistoryState,
  MainlineChoice,
} from "./historyTypes";

const AUTOMATIC_BASE: BaseSelection = { kind: "automatic" };

/** A request the current state cannot honour, such as an unknown commit or parent. */
export class HistoryRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryRequestError";
  }
}

/** Tracks the one live run of an operation; starting a new run cancels the old one. */
class LatestOperation {
  private controller: AbortController | null = null;

  get isActive(): boolean {
    return this.controller !== null;
  }

  begin(): AbortSignal {
    this.cancel();
    this.controller = new AbortController();
    return this.controller.signal;
  }

  /** Ends the run `signal` belongs to; false when it was already superseded or cancelled. */
  complete(signal: AbortSignal): boolean {
    const isCurrent = this.controller?.signal === signal;
    if (isCurrent) {
      this.controller = null;
    }
    return isCurrent;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }
}

/**
 * Host-independent history workflow for one repository: holds the selection,
 * base and merge-parent choices and the comparison they produce. State changes
 * synchronously when a method is called and again before its promise settles;
 * a host publishes `getState()` after each. Superseded operations are aborted
 * and their late results ignored. The host is responsible for debouncing.
 */
export class HistoryController {
  private readonly loading = new LatestOperation();
  private readonly baseResolution = new LatestOperation();
  private readonly comparing = new LatestOperation();
  private commitsByOid: ReadonlyMap<string, HistoryCommit> = new Map();
  private isDisposed = false;
  private state: HistoryState = {
    revision: 0,
    history: null,
    selectedOids: [],
    base: AUTOMATIC_BASE,
    mainlines: [],
    comparison: null,
    operations: { isLoading: false, isResolvingBase: false, isComparing: false },
    error: null,
  };

  constructor(private readonly repository: HistoryRepository) {}

  getState(): HistoryState {
    return this.state;
  }

  /** Reads metadata; on failure the previous metadata stays with a visible error. */
  async load(): Promise<void> {
    this.assertActive();
    const signal = this.loading.begin();
    this.update({ error: this.errorExcept("load") });

    try {
      const history = await this.repository.loadHistory(signal);
      if (!this.loading.complete(signal)) {
        return;
      }
      this.commitsByOid = new Map(history.commits.map((commit) => [commit.oid, commit]));
      this.update({ history });
    } catch (error) {
      this.failIfCurrent(this.loading, signal, "load", error);
    }
  }

  /** Replaces the selection; any comparison of a different previous selection is discarded. Order is irrelevant. */
  setSelection(oids: readonly string[]): void {
    this.assertActive();
    const selectedOids = [...new Set(oids)];
    const unknownOid = selectedOids.find((oid) => !this.commitsByOid.has(oid));
    if (unknownOid !== undefined) {
      throw new HistoryRequestError(`Commit ${unknownOid} is not in the loaded history.`);
    }

    const currentOids = new Set(this.state.selectedOids);
    const isUnchanged = selectedOids.length === currentOids.size && selectedOids.every((oid) => currentOids.has(oid));
    if (isUnchanged) {
      return;
    }

    this.update({ ...this.discardComparison(), selectedOids });
  }

  /** `null` selects the Automatic base; a ref is resolved once and pinned to its commit. */
  async setBase(ref: string | null): Promise<void> {
    this.assertActive();
    if (ref === null) {
      this.baseResolution.cancel();
      this.selectAutomaticBase();
      return;
    }

    const signal = this.baseResolution.begin();
    this.update({ error: this.errorExcept("resolveBase") });

    try {
      const commit = await this.repository.resolveRef(ref, signal);
      if (!this.baseResolution.complete(signal)) {
        return;
      }
      this.applyBase({ kind: "pinned", oid: commit.oid, label: ref });
    } catch (error) {
      this.failIfCurrent(this.baseResolution, signal, "resolveBase", error);
    }
  }

  /** Chooses which one-based parent a merge commit's patch is taken against. */
  setMainline(oid: string, parentNumber: number): void {
    this.assertActive();
    const commit = this.commitsByOid.get(oid);
    if (!commit) {
      throw new HistoryRequestError(`Commit ${oid} is not in the loaded history.`);
    }

    const isMerge = commit.parents.length > 1;
    if (!isMerge) {
      throw new HistoryRequestError(`Commit ${oid} is not a merge.`);
    }

    const isValidParent = Number.isInteger(parentNumber) && parentNumber >= 1
      && parentNumber <= commit.parents.length;
    if (!isValidParent) {
      throw new HistoryRequestError(`Commit ${oid} has no parent ${parentNumber}.`);
    }

    const isUnchanged = this.state.mainlines
      .some((choice) => choice.oid === oid && choice.parentNumber === parentNumber);
    if (isUnchanged) {
      return;
    }

    const otherChoices = this.state.mainlines.filter((choice) => choice.oid !== oid);
    this.update({ ...this.discardComparison(), mainlines: [...otherChoices, { oid, parentNumber }] });
  }

  /** Compares the current selection; an empty selection simply has no comparison. */
  async compare(): Promise<void> {
    this.assertActive();
    if (this.state.selectedOids.length === 0) {
      this.update(this.discardComparison());
      return;
    }

    const request = this.comparisonRequest();
    const signal = this.comparing.begin();
    this.update({ error: this.errorExcept("compare") });

    try {
      const comparison = await this.repository.compare(request, signal);
      if (!this.comparing.complete(signal)) {
        this.release(comparison);
        return;
      }
      this.release(this.state.comparison);
      this.update({ comparison });
    } catch (error) {
      this.failIfCurrent(this.comparing, signal, "compare", error);
    }
  }

  /** Cancels all pending work and releases the current snapshot. */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.loading.cancel();
    this.baseResolution.cancel();
    this.update(this.discardComparison());
  }

  /** Keeps the comparison when the base already is Automatic; the update still clears a cancelled resolution. */
  private selectAutomaticBase(): void {
    if (this.state.base.kind === "automatic") {
      this.update({ error: this.errorExcept("resolveBase") });
      return;
    }
    this.applyBase(AUTOMATIC_BASE);
  }

  /** Switches base; any base-resolution error no longer applies. */
  private applyBase(base: BaseSelection): void {
    this.update({ ...this.discardComparison(), base, error: this.errorExcept("compare", "resolveBase") });
  }

  private comparisonRequest(): ComparisonRequest {
    const selected = new Set(this.state.selectedOids);
    const mainlines: readonly MainlineChoice[] = this.state.mainlines
      .filter((choice) => selected.has(choice.oid));
    return { selectedOids: this.state.selectedOids, base: this.state.base, mainlines };
  }

  /** Cancels any running comparison, releases the current one and returns the changes that forget it. */
  private discardComparison(): Pick<HistoryState, "comparison" | "error"> {
    this.comparing.cancel();
    this.release(this.state.comparison);
    return { comparison: null, error: this.errorExcept("compare") };
  }

  private release(comparison: ComparisonResult | null): void {
    if (comparison?.kind === "ready") {
      this.repository.releaseSnapshot(comparison.snapshotId);
    }
  }

  private failIfCurrent(
    operation: LatestOperation,
    signal: AbortSignal,
    kind: HistoryOperation,
    error: unknown,
  ): void {
    if (!operation.complete(signal)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.update({ error: { operation: kind, message } });
  }

  /** The current error unless it belongs to one of `operations`. */
  private errorExcept(...operations: readonly HistoryOperation[]): HistoryError | null {
    const error = this.state.error;
    return error && operations.includes(error.operation) ? null : error;
  }

  /** Applies changes, refreshes operation flags and advances the revision. */
  private update(changes: Partial<HistoryState>): void {
    this.state = {
      ...this.state,
      ...changes,
      operations: {
        isLoading: this.loading.isActive,
        isResolvingBase: this.baseResolution.isActive,
        isComparing: this.comparing.isActive,
      },
      revision: this.state.revision + 1,
    };
  }

  private assertActive(): void {
    if (this.isDisposed) {
      throw new HistoryRequestError("The history controller has been disposed.");
    }
  }
}
