import type { HistoryCommit, HistoryData } from "./historyTypes";

/** The view-only filters that decide which commits the table lists. */
export interface CommitFilter {
  readonly search: string;
  /** Tip OID of the branch filter; null shows all branches. */
  readonly branchOid: string | null;
}

/** Ancestors of the branch tip within loaded metadata, then literal case-insensitive subject/hash matching. */
export function filterVisibleOids(history: HistoryData | null, filter: CommitFilter): readonly string[] {
  const commits = history?.commits ?? [];
  const reachable = filter.branchOid === null ? null : reachableFrom(commits, filter.branchOid);
  return matchingOids(commits, reachable, filter.search);
}

/** OIDs of `tipOid` and its ancestors among `commits`; empty when the tip is not loaded. */
export function reachableFrom(commits: readonly HistoryCommit[], tipOid: string): ReadonlySet<string> {
  const byOid = new Map(commits.map((commit) => [commit.oid, commit]));
  const reached = new Set<string>();
  const pending = [tipOid];
  while (pending.length > 0) {
    const oid = pending.pop()!;
    const commit = byOid.get(oid);
    if (commit && !reached.has(oid)) {
      reached.add(oid);
      pending.push(...commit.parents);
    }
  }
  return reached;
}

/**
 * `filterVisibleOids` remembering its last result and last branch walk, so publications that change neither the
 * loaded history nor the filters do not walk the graph again. Histories are compared by identity: a reload yields a
 * new object.
 */
export class VisibleCommitCache {
  private lastVisible: { readonly history: HistoryData | null; readonly filter: CommitFilter; readonly oids: readonly string[] } | null = null;
  private lastReachable: { readonly history: HistoryData; readonly tipOid: string; readonly oids: ReadonlySet<string> } | null = null;

  visibleOids(history: HistoryData | null, filter: CommitFilter): readonly string[] {
    const last = this.lastVisible;
    const isCached = last !== null && last.history === history
      && last.filter.search === filter.search && last.filter.branchOid === filter.branchOid;
    if (isCached) {
      return last.oids;
    }
    const reachable = history === null || filter.branchOid === null ? null : this.reachable(history, filter.branchOid);
    const oids = matchingOids(history?.commits ?? [], reachable, filter.search);
    this.lastVisible = { history, filter: { search: filter.search, branchOid: filter.branchOid }, oids };
    return oids;
  }

  private reachable(history: HistoryData, tipOid: string): ReadonlySet<string> {
    const last = this.lastReachable;
    if (last !== null && last.history === history && last.tipOid === tipOid) {
      return last.oids;
    }
    const oids = reachableFrom(history.commits, tipOid);
    this.lastReachable = { history, tipOid, oids };
    return oids;
  }
}

function matchingOids(commits: readonly HistoryCommit[], reachable: ReadonlySet<string> | null, search: string): readonly string[] {
  const query = search.trim().toLowerCase();
  return commits
    .filter((commit) => reachable === null || reachable.has(commit.oid))
    .filter((commit) => query === "" || commit.oid.includes(query) || commit.subject.toLowerCase().includes(query))
    .map((commit) => commit.oid);
}
