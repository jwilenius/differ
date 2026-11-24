/**
 * The two pseudo-commits for uncommitted changes: what is staged in the index, and what differs on disk from it.
 * Their IDs can never be a hex commit OID, so they share selection lists with commits.
 */

export const STAGED_CHANGES_ID = "working:staged";
export const UNSTAGED_CHANGES_ID = "working:unstaged";

export type WorkingChangeId = typeof STAGED_CHANGES_ID | typeof UNSTAGED_CHANGES_ID;

/** Replay order: staged changes apply before unstaged ones, after every selected commit. */
export const WORKING_CHANGE_REPLAY_ORDER: readonly WorkingChangeId[] = [STAGED_CHANGES_ID, UNSTAGED_CHANGES_ID];

/** At most this many changed paths are read; the rest are left out and the summary says so. */
export const WORKING_CHANGE_PATH_LIMIT = 5_000;

/** Changed-file counts of the working tree; every count stops at `WORKING_CHANGE_PATH_LIMIT` paths in total. */
export interface WorkingChangeCounts {
  /** Files whose index entry differs from HEAD. */
  readonly staged: number;
  /** Files on disk that differ from the index, including untracked and conflicted ones. */
  readonly unstaged: number;
  /** Untracked files, also counted in `unstaged`. */
  readonly untracked: number;
  /** Files with unresolved merge conflicts, also counted in `unstaged`; the HEAD version stands in the index. */
  readonly conflicted: number;
  /** More changed paths exist than were read. */
  readonly isTruncated: boolean;
}

/** The counts of one read, with a key that tells whether the changes' content differs from another read's. */
export interface WorkingChangeSummary extends WorkingChangeCounts {
  /** Equal between two reads that found the same staged and unstaged content. */
  readonly contentKey: string;
}

const LABELS: Readonly<Record<WorkingChangeId, string>> = {
  [STAGED_CHANGES_ID]: "Staged changes",
  [UNSTAGED_CHANGES_ID]: "Unstaged changes",
};

export function isWorkingChangeId(value: string): value is WorkingChangeId {
  return value === STAGED_CHANGES_ID || value === UNSTAGED_CHANGES_ID;
}

export function workingChangeLabel(id: WorkingChangeId): string {
  return LABELS[id];
}

/** How many files the pseudo-commit `id` changes. */
export function workingChangeCount(summary: WorkingChangeSummary, id: WorkingChangeId): number {
  return id === STAGED_CHANGES_ID ? summary.staged : summary.unstaged;
}

/** Whether two reads found the same changes: the same counts and content. */
export function isSameWorkingChangeSummary(a: WorkingChangeSummary | null, b: WorkingChangeSummary | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.staged === b.staged && a.unstaged === b.unstaged && a.untracked === b.untracked
    && a.conflicted === b.conflicted && a.isTruncated === b.isTruncated && a.contentKey === b.contentKey;
}

/** Pseudo-commits with changes, in replay order; none without a summary. */
export function presentWorkingChangeIds(summary: WorkingChangeSummary | null): readonly WorkingChangeId[] {
  if (summary === null) {
    return [];
  }
  return WORKING_CHANGE_REPLAY_ORDER.filter((id) => workingChangeCount(summary, id) > 0);
}

/**
 * Lower-case description of a selection for status lines and titles, such as `2 selected commits`, `staged changes`
 * or `1 selected commit and staged and unstaged changes`.
 */
export function describeSelectedChanges(ids: readonly string[]): string {
  const commitCount = ids.filter((id) => !isWorkingChangeId(id)).length;
  const workingIds = WORKING_CHANGE_REPLAY_ORDER.filter((id) => ids.includes(id));
  const workingText = workingIds.length === WORKING_CHANGE_REPLAY_ORDER.length
    ? "staged and unstaged changes"
    : workingIds.map((id) => workingChangeLabel(id).toLowerCase()).join("");
  const commitText = `${commitCount} selected commit${commitCount === 1 ? "" : "s"}`;
  if (workingText === "") {
    return commitText;
  }
  return commitCount === 0 ? workingText : `${commitText} and ${workingText}`;
}
