import type { ResolvedBase } from "./historyTypes";

/** Hex digits shown wherever a commit is abbreviated. */
export const SHORT_HASH_LENGTH = 8;

export function shortHash(oid: string): string {
  return oid.slice(0, SHORT_HASH_LENGTH);
}

/** Plain-text name of the tree a comparison starts from: a short hash or `empty tree`. */
export function describeResolvedBase(base: ResolvedBase): string {
  return base.kind === "commit" ? shortHash(base.oid) : "empty tree";
}
