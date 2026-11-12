/**
 * Renderer- and host-independent contracts for the Git history workflow. Every
 * type here is readonly plain data, so any state built from them survives
 * `JSON.stringify` unchanged and can cross a webview boundary.
 *
 * Commit OIDs are full lowercase hex (40 characters for SHA-1, 64 for SHA-256).
 * Snapshot and file IDs are opaque UUIDs issued by the Git adapter. Paths are
 * display data only and never address content.
 */

/** One commit's metadata as listed in the history table. */
export interface HistoryCommit {
  readonly oid: string;
  /** Parent OIDs in Git order; empty for a root commit. */
  readonly parents: readonly string[];
  readonly author: string;
  /** Strict ISO 8601 author date, as produced by `%aI`. */
  readonly authoredDate: string;
  readonly subject: string;
}

export type HistoryRefKind = "head" | "localBranch" | "remoteBranch" | "tag";

/** A label pointing at a commit; annotated tags are already peeled. */
export interface HistoryRef {
  readonly kind: HistoryRefKind;
  /** Short display name such as `main`, `origin/main`, `v1.0` or `HEAD`. */
  readonly name: string;
  readonly oid: string;
}

/** The loaded graph: commits ordered children before parents, plus their labels. */
export interface HistoryData {
  readonly commits: readonly HistoryCommit[];
  readonly refs: readonly HistoryRef[];
}

/** Base derived from the selection's single earliest commit. */
export interface AutomaticBase {
  readonly kind: "automatic";
}

/** Base the user named once; it stays on the resolved commit even if the ref moves. */
export interface PinnedBase {
  readonly kind: "pinned";
  readonly oid: string;
  /** What the user typed or picked, for display. */
  readonly label: string;
}

export type BaseSelection = AutomaticBase | PinnedBase;

/** Which parent a selected merge commit's patch is taken against. */
export interface MainlineChoice {
  readonly oid: string;
  /** One-based index into the commit's `parents`. */
  readonly parentNumber: number;
}

export interface ComparisonRequest {
  /** Selected commits in no meaningful order; replay order is decided by Git. */
  readonly selectedOids: readonly string[];
  readonly base: BaseSelection;
  /** Choices for selected merges only; unlisted merges use parent 1. */
  readonly mainlines: readonly MainlineChoice[];
}

export interface CommitBase {
  readonly kind: "commit";
  readonly oid: string;
  readonly subject: string;
}

export interface EmptyTreeBase {
  readonly kind: "emptyTree";
}

/** The concrete tree a comparison starts from. */
export type ResolvedBase = CommitBase | EmptyTreeBase;

/** The selection has several earliest commits, so the user must pin a base. */
export interface NeedsBaseResult {
  readonly kind: "needsBase";
  readonly minimumOids: readonly string[];
}

/** Replay stopped at the first commit whose patch did not apply; no files exist. */
export interface BlockedResult {
  readonly kind: "blocked";
  readonly base: ResolvedBase;
  /** Selected commits in replay order. */
  readonly orderedOids: readonly string[];
  readonly failingOid: string;
  readonly paths: readonly string[];
  readonly explanation: string;
}

/** A completed replay whose files can be opened until the snapshot is released. */
export interface ReadyResult {
  readonly kind: "ready";
  readonly snapshotId: string;
  readonly base: ResolvedBase;
  /** Selected commits in replay order, including ones that turned out to be no-ops. */
  readonly orderedOids: readonly string[];
  /** Net base-to-result changes; empty when the selected changes cancel out. */
  readonly files: readonly ComparisonFile[];
}

export type ComparisonResult = NeedsBaseResult | BlockedResult | ReadyResult;

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "typeChanged";

/** How a file's content can be shown; gitlinks show their submodule OIDs as text. */
export type FileContentKind = "text" | "binary" | "gitlink";

/** One side of a changed file in the base or result tree. */
export interface ComparisonFileSide {
  readonly path: string;
  readonly blob: string;
  /** Octal Git mode such as `100644`, `100755`, `120000` or `160000`. */
  readonly mode: string;
}

export interface ComparisonFile {
  readonly id: string;
  readonly status: FileStatus;
  /** Absent for an added file. */
  readonly base: ComparisonFileSide | null;
  /** Absent for a deleted file. */
  readonly result: ComparisonFileSide | null;
  readonly contentKind: FileContentKind;
}

export type FileSide = "base" | "result";

export interface TextContent {
  readonly kind: "text";
  readonly text: string;
}

export type NonTextReason = "binary" | "invalidEncoding" | "oversize";

/** Content that must not be decoded as source; shown as an explanation instead. */
export interface NonTextContent {
  readonly kind: "nonText";
  readonly reason: NonTextReason;
  readonly explanation: string;
  readonly sizeBytes: number;
  readonly mode: string;
}

export type FileContentResult = TextContent | NonTextContent;

/**
 * The port a Git adapter implements for one repository. Every call that does
 * I/O honours `signal` and rejects once it is aborted.
 */
export interface HistoryRepository {
  loadHistory(signal: AbortSignal): Promise<HistoryData>;
  /** Resolves a branch, tag or hash to the commit it names right now. */
  resolveRef(ref: string, signal: AbortSignal): Promise<HistoryCommit>;
  compare(request: ComparisonRequest, signal: AbortSignal): Promise<ComparisonResult>;
  readFile(snapshotId: string, fileId: string, side: FileSide, signal: AbortSignal): Promise<FileContentResult>;
  /**
   * Stops new reads of a snapshot and frees it once active reads finish. Fire
   * and forget: the adapter owns its cleanup failures. Repeated calls are harmless.
   */
  releaseSnapshot(snapshotId: string): void;
}

export type HistoryOperation = "load" | "resolveBase" | "compare";

export interface OperationStatus {
  readonly isLoading: boolean;
  readonly isResolvingBase: boolean;
  readonly isComparing: boolean;
}

export interface HistoryError {
  readonly operation: HistoryOperation;
  readonly message: string;
}

/** Everything a renderer needs about one repository's history workflow. */
export interface HistoryState {
  /** Increases with every change, so publishers can drop stale copies. */
  readonly revision: number;
  /** Last successfully loaded metadata; kept when a reload fails. */
  readonly history: HistoryData | null;
  /** Deduplicated, in the order the user selected them. */
  readonly selectedOids: readonly string[];
  readonly base: BaseSelection;
  readonly mainlines: readonly MainlineChoice[];
  /** Result for the current selection, base and mainlines; null until computed. */
  readonly comparison: ComparisonResult | null;
  readonly operations: OperationStatus;
  readonly error: HistoryError | null;
}
