import type { HistoryData, HistoryRef } from "./historyTypes";

/**
 * The branch the commit list is limited to. It is kept by ref name and resolved against each loaded history, so it
 * follows the branch as it moves; `tipOid` is the commit the ref points at in the history it was resolved against.
 */
export interface BranchFilter {
  /** `refs/heads/<name>`, `refs/remotes/<name>`, or `HEAD` for a detached HEAD. */
  readonly ref: string;
  readonly tipOid: string;
}

const DETACHED_HEAD_REF = "HEAD";
const BRANCH_PREFIXES = [
  { prefix: "refs/heads/", kind: "localBranch" },
  { prefix: "refs/remotes/", kind: "remoteBranch" },
] as const;

/** What a filter ref names: a ref of `kind` with the display `name` `HistoryRef` uses. */
interface RefKey {
  readonly kind: HistoryRef["kind"];
  readonly name: string;
}

/** The filter ref naming `ref`; null for a tag, which is not offered as a branch. */
export function branchFilterRef(ref: HistoryRef): string | null {
  if (ref.kind === "head") {
    return DETACHED_HEAD_REF;
  }
  const namespace = BRANCH_PREFIXES.find((candidate) => candidate.kind === ref.kind);
  return namespace ? namespace.prefix + ref.name : null;
}

/** Whether `value` has the shape of a filter ref; says nothing about whether such a ref exists. */
export function isBranchFilterRef(value: string): boolean {
  return parseBranchFilterRef(value) !== null;
}

/** The filter for `ref` when `history` has it and `isLoaded` reports its tip as loaded; otherwise null. */
export function resolveBranchFilter(
  history: HistoryData | null,
  ref: string,
  isLoaded: (oid: string) => boolean,
): BranchFilter | null {
  const key = parseBranchFilterRef(ref);
  const match = key && history?.refs.find((candidate) => candidate.kind === key.kind && candidate.name === key.name);
  return match && isLoaded(match.oid) ? { ref, tipOid: match.oid } : null;
}

function parseBranchFilterRef(value: string): RefKey | null {
  if (value === DETACHED_HEAD_REF) {
    return { kind: "head", name: DETACHED_HEAD_REF };
  }
  const namespace = BRANCH_PREFIXES.find((candidate) => value.startsWith(candidate.prefix));
  const name = namespace ? value.slice(namespace.prefix.length) : "";
  return namespace && name !== "" ? { kind: namespace.kind, name } : null;
}
