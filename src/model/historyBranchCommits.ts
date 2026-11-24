import { headBranchFilter, isPickedBranch } from "./historyBranchFilter";
import type { BranchFilter } from "./historyBranchFilter";
import { shortRefName } from "./historyRefNames";
import type { HistoryData } from "./historyTypes";
import type { WorkingChangeId } from "./historyWorkingChanges";

/**
 * What Select branch picks for a branch: the commits on it that its base lacks, or why it has no base. The base is the
 * default branch, or the branch's upstream when it is the default branch itself. Names are short display names such as
 * `feature`, `origin/main` or `HEAD`.
 */
export type BranchCommits = CommitsBeyondBase | MissingDefaultBranch | MissingUpstream;

export interface CommitsBeyondBase {
  readonly kind: "commits";
  readonly branch: string;
  readonly base: string;
  /** `base` is the branch's upstream, so `oids` are its commits not yet pushed. */
  readonly isUpstream: boolean;
  /** Reachable from the branch but not from `base`, children before parents. */
  readonly oids: readonly string[];
}

/** No `origin/HEAD`, `main` or `master` exists. */
export interface MissingDefaultBranch {
  readonly kind: "noDefaultBranch";
  readonly branch: string;
}

/** The branch is the default branch and has no upstream to compare with. */
export interface MissingUpstream {
  readonly kind: "noUpstream";
  readonly branch: string;
}

/** What is known of a branch's commits: still being read, unreadable, or read. */
export type BranchCommitsLookup = BranchCommits | { readonly kind: "reading" } | { readonly kind: "failed" };

/** The branch Select branch works on. */
export interface SelectBranchTarget {
  /** Full ref name, or `HEAD` for a detached HEAD. */
  readonly ref: string;
  /** The working tree has it checked out, so its uncommitted changes belong to it. */
  readonly isCheckedOut: boolean;
}

/** What a Select branch click does now, and the tooltip saying so or why it cannot. */
export interface SelectBranchAction {
  /** Working changes and loaded commits a click selects; empty while the button is disabled. */
  readonly ids: readonly string[];
  /** Commits on the branch older than the loaded history, which a click cannot select. */
  readonly unloadedCount: number;
  readonly title: string;
}

/**
 * The branch picked in the branch filter, else HEAD's branch or detached commit; null without either, as in an unborn
 * repository.
 */
export function selectBranchTarget(
  history: HistoryData | null,
  branchChoice: string | null,
  branch: BranchFilter | null,
  isLoaded: (oid: string) => boolean,
): SelectBranchTarget | null {
  const checkedOut = headBranchFilter(history, isLoaded);
  const ref = isPickedBranch(branchChoice) && branch !== null ? branch.ref : checkedOut?.ref;
  return ref === undefined ? null : { ref, isCheckedOut: ref === checkedOut?.ref };
}

/**
 * Select branch for `target`, whose commits `lookup` describes: its loaded commits beyond the base, plus `workingIds`
 * when it is checked out.
 */
export function selectBranchAction(
  target: SelectBranchTarget | null,
  lookup: BranchCommitsLookup,
  workingIds: readonly WorkingChangeId[],
  isLoaded: (oid: string) => boolean,
): SelectBranchAction {
  if (target === null) {
    return disabled("No checked-out commit to select a branch from");
  }
  const branch = shortRefName(target.ref);
  switch (lookup.kind) {
    case "reading":
      return disabled(`Finding the commits on ${branch}…`);
    case "failed":
      return disabled(`Could not find the commits on ${branch}; the jw-differ History output has details`);
    case "noDefaultBranch":
      return disabled("No default branch found: there is no origin/HEAD, main or master");
    case "noUpstream":
      return disabled(`${branch} has no upstream branch to find unpushed commits against`);
  }

  const commitOids = lookup.oids.filter(isLoaded);
  const includedWorkingIds = target.isCheckedOut ? workingIds : [];
  if (commitOids.length === 0) {
    return withoutLoadedCommits(branch, lookup, includedWorkingIds);
  }
  const commits = lookup.isUpstream
    ? `Select commits on ${branch} not yet pushed to ${lookup.base}`
    : `Select every commit on ${branch} that is not on ${lookup.base}`;
  const title = includedWorkingIds.length > 0 ? `${commits}, plus uncommitted changes` : commits;
  const ids = [...includedWorkingIds, ...commitOids];
  return { ids, unloadedCount: lookup.oids.length - commitOids.length, title };
}

/** Select branch when none of the branch's commits is loaded: only its working changes, or nothing. */
function withoutLoadedCommits(
  branch: string,
  lookup: CommitsBeyondBase,
  workingIds: readonly WorkingChangeId[],
): SelectBranchAction {
  const isHistoryShort = lookup.oids.length > 0;
  if (workingIds.length === 0) {
    return disabled(isHistoryShort
      ? `The commits on ${branch} beyond ${lookup.base} are not in the loaded history`
      : `No commits on ${branch} beyond ${lookup.base}`);
  }
  const reason = isHistoryShort
    ? `the commits on ${branch} beyond ${lookup.base} are not in the loaded history`
    : `${branch} has no commits beyond ${lookup.base}`;
  return { ids: workingIds, unloadedCount: lookup.oids.length, title: `Select only the uncommitted changes: ${reason}` };
}

function disabled(title: string): SelectBranchAction {
  return { ids: [], unloadedCount: 0, title };
}
