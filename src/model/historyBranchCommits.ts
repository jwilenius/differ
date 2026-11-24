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
