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
export interface WorkingChangeSummary {
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

/** Pseudo-commits with changes, in replay order; none without a summary. */
export function presentWorkingChangeIds(summary: WorkingChangeSummary | null): readonly WorkingChangeId[] {
  if (summary === null) {
    return [];
  }
  return WORKING_CHANGE_REPLAY_ORDER.filter((id) => workingChangeCount(summary, id) > 0);
}
