import { LOCAL_BRANCH_PREFIX, REF_NAMESPACES } from "./historyRefNames";
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

/**
 * The branch filter option that follows HEAD: the checked-out branch, or HEAD's commit when detached. It is no filter
 * ref, so it never names a branch the user picked.
 */
export const CHECKED_OUT_BRANCH = "checked-out";

const DETACHED_HEAD_REF = "HEAD";
/** Tags are not offered as branches. */
const BRANCH_PREFIXES = REF_NAMESPACES.filter((namespace) => namespace.kind !== "tag");

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

/** Whether `value` is a branch filter option other than All branches: the checked-out branch or a filter ref. */
export function isBranchChoice(value: string): boolean {
  return value === CHECKED_OUT_BRANCH || isBranchFilterRef(value);
}

/** Whether `choice` names a branch the user picked, rather than All branches or the checked-out branch. */
export function isPickedBranch(choice: string | null): choice is string {
  return choice !== null && choice !== CHECKED_OUT_BRANCH;
}

/**
 * The filter `choice` names in `history`: `CHECKED_OUT_BRANCH` follows HEAD, any other value is a filter ref. Null for
 * all branches (`choice` null), and when the ref is missing or its tip is not loaded.
 */
export function resolveBranchChoice(
  history: HistoryData | null,
  choice: string | null,
  isLoaded: (oid: string) => boolean,
): BranchFilter | null {
  if (choice === CHECKED_OUT_BRANCH) {
    return headBranchFilter(history, isLoaded);
  }
  return choice === null ? null : resolveBranchFilter(history, choice, isLoaded);
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

/**
 * The filter for HEAD's branch, or for HEAD's commit when detached, while its tip is loaded; null for an unborn or
 * missing HEAD.
 */
export function headBranchFilter(history: HistoryData | null, isLoaded: (oid: string) => boolean): BranchFilter | null {
  const head = history?.head;
  if (!head) {
    return null;
  }
  const ref = head.branch === null ? DETACHED_HEAD_REF : `${LOCAL_BRANCH_PREFIX}${head.branch}`;
  return resolveBranchFilter(history, ref, isLoaded);
}

function parseBranchFilterRef(value: string): RefKey | null {
  if (value === DETACHED_HEAD_REF) {
    return { kind: "head", name: DETACHED_HEAD_REF };
  }
  const namespace = BRANCH_PREFIXES.find((candidate) => value.startsWith(candidate.prefix));
  const name = namespace ? value.slice(namespace.prefix.length) : "";
  return namespace && name !== "" ? { kind: namespace.kind, name } : null;
}
