import type { HistoryRefKind } from "./historyTypes";

/** Where local branches live; a local branch's `HistoryRef.name` is its ref name without this prefix. */
export const LOCAL_BRANCH_PREFIX = "refs/heads/";

/** The ref namespaces the history lists, each with the kind its refs get; a ref's name is the part after the prefix. */
export const REF_NAMESPACES: ReadonlyArray<{ readonly prefix: string; readonly kind: HistoryRefKind }> = [
  { prefix: LOCAL_BRANCH_PREFIX, kind: "localBranch" },
  { prefix: "refs/remotes/", kind: "remoteBranch" },
  { prefix: "refs/tags/", kind: "tag" },
];
