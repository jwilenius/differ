import type {
  ComparisonRequest,
  EmptyTreeBase,
  HistoryCommit,
  MainlineChoice,
  NeedsBaseResult,
  ResolvedBase,
} from "../model/historyTypes";
import { HistoryOutputError, isFullOid } from "./gitHistoryRepository";
import type { GitHistoryRepository } from "./gitHistoryRepository";

const EMPTY_TREE: EmptyTreeBase = { kind: "emptyTree" };

/** A commit together with the tree it records. */
export interface CommitTree {
  readonly kind: "commit";
  readonly oid: string;
  readonly treeOid: string;
}

/** Where a patch or the comparison starts: a commit's tree, or the empty tree for roots. */
export type ReplayTree = CommitTree | EmptyTreeBase;

/** One selected commit's patch: `parent` tree → commit tree. */
export interface ReplayStep {
  readonly oid: string;
  readonly treeOid: string;
  /** The chosen mainline parent, or the empty tree for a root commit. */
  readonly parent: ReplayTree;
}

/** One reproducible interpretation of a request: what to start from and which patches to apply in order. */
export interface ResolvedHistoryComparison {
  readonly kind: "resolved";
  readonly base: ResolvedBase;
  readonly baseTree: ReplayTree;
  /** Selected commits in Git's topological replay order, oldest first. */
  readonly steps: readonly ReplayStep[];
}

export type HistoryComparisonResolution = ResolvedHistoryComparison | NeedsBaseResult;

export type HistoryComparisonErrorKind = "emptySelection" | "invalidMainline" | "shallowHistory";

/** A request that cannot be interpreted without guessing. */
export class HistoryComparisonError extends Error {
  constructor(
    message: string,
    readonly kind: HistoryComparisonErrorKind,
  ) {
    super(message);
    this.name = "HistoryComparisonError";
  }
}

interface SelectionOrder {
  /** Selected OIDs, oldest first. */
  readonly orderedOids: readonly string[];
  /** Selected commits with no selected ancestor, in the same order. */
  readonly minimumOids: readonly string[];
}

/**
 * Decides base, replay order and each selected commit's patch parent, independent of how the selection was made.
 * Several earliest commits under an Automatic base need an explicit base instead of a guess.
 */
export async function resolveHistoryComparison(
  repository: GitHistoryRepository,
  request: ComparisonRequest,
  signal: AbortSignal,
): Promise<HistoryComparisonResolution> {
  const selectedOids = [...new Set(request.selectedOids)];
  if (selectedOids.length === 0) {
    throw new HistoryComparisonError("Select at least one commit to compare.", "emptySelection");
  }

  const commits = await repository.readCommits(selectedOids, signal);
  await assertParentsAvailable(repository, selectedOids, signal);
  const parentOids = chooseParents(commits, request.mainlines);

  const order = await readSelectionOrder(repository, selectedOids, signal);
  const isBaseAmbiguous = request.base.kind === "automatic" && order.minimumOids.length > 1;
  if (isBaseAmbiguous) {
    return { kind: "needsBase", minimumOids: order.minimumOids };
  }

  const baseOid = request.base.kind === "pinned" ? request.base.oid : parentOids.get(order.minimumOids[0]) ?? null;
  const base = await resolveBase(repository, baseOid, signal);
  const treeCommitOids = [...selectedOids, ...parentOids.values(), ...(baseOid === null ? [] : [baseOid])];
  const trees = await repository.readTreeOids(treeCommitOids, signal);

  const steps = order.orderedOids.map((oid): ReplayStep => ({
    oid,
    treeOid: treeOf(trees, oid),
    parent: replayTree(trees, parentOids.get(oid) ?? null),
  }));
  return { kind: "resolved", base, baseTree: replayTree(trees, baseOid), steps };
}

/** A shallow boundary commit looks like a root; treating it as one would invent a patch adding its whole tree. */
async function assertParentsAvailable(
  repository: GitHistoryRepository,
  selectedOids: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const shallowOids = await repository.readShallowOids(signal);
  const boundaryOid = selectedOids.find((oid) => shallowOids.has(oid));
  if (boundaryOid !== undefined) {
    const message = `The parents of commit ${boundaryOid} are missing from this shallow clone. `
      + "Deepen the history with Git outside Differ, then compare again.";
    throw new HistoryComparisonError(message, "shallowHistory");
  }
}

/** Selected commit → chosen parent OID; root commits have none. Merges default to parent 1. */
function chooseParents(
  commits: readonly HistoryCommit[],
  mainlines: readonly MainlineChoice[],
): ReadonlyMap<string, string> {
  const commitsByOid = new Map(commits.map((commit) => [commit.oid, commit]));
  const parentNumbers = new Map<string, number>();
  for (const choice of mainlines) {
    validateMainline(choice, commitsByOid.get(choice.oid), parentNumbers.has(choice.oid));
    parentNumbers.set(choice.oid, choice.parentNumber);
  }

  return new Map(commits.flatMap((commit) => {
    const parentOid = commit.parents[(parentNumbers.get(commit.oid) ?? 1) - 1];
    return parentOid === undefined ? [] : [[commit.oid, parentOid] as const];
  }));
}

function validateMainline(choice: MainlineChoice, commit: HistoryCommit | undefined, isDuplicate: boolean): void {
  if (commit === undefined) {
    const message = `Mainline choice for ${choice.oid} names an unselected commit.`;
    throw new HistoryComparisonError(message, "invalidMainline");
  }
  if (isDuplicate) {
    throw new HistoryComparisonError(`Commit ${choice.oid} has more than one mainline choice.`, "invalidMainline");
  }

  const isValidParent = Number.isInteger(choice.parentNumber) && choice.parentNumber >= 1
    && choice.parentNumber <= commit.parents.length;
  if (!isValidParent) {
    throw new HistoryComparisonError(`Commit ${choice.oid} has no parent ${choice.parentNumber}.`, "invalidMainline");
  }
}

/**
 * Walks every ancestor of the selection once, parents before children. A selected commit is a minimum when no
 * parent path, through selected or unselected commits, reaches another selected commit.
 */
async function readSelectionOrder(
  repository: GitHistoryRepository,
  selectedOids: readonly string[],
  signal: AbortSignal,
): Promise<SelectionOrder> {
  // Lexically sorted input makes Git's order between unrelated commits independent of selection order.
  const ancestry = await repository.readAncestry([...selectedOids].sort(), signal);

  const selected = new Set(selectedOids);
  const reachesSelection = new Set<string>();
  const orderedOids: string[] = [];
  const minimumOids: string[] = [];
  for (const { oid, parents } of ancestry) {
    const hasSelectedAncestor = parents.some((parent) => reachesSelection.has(parent));
    if (selected.has(oid)) {
      orderedOids.push(oid);
      if (!hasSelectedAncestor) {
        minimumOids.push(oid);
      }
    }
    if (selected.has(oid) || hasSelectedAncestor) {
      reachesSelection.add(oid);
    }
  }
  return { orderedOids, minimumOids };
}

async function resolveBase(
  repository: GitHistoryRepository,
  baseOid: string | null,
  signal: AbortSignal,
): Promise<ResolvedBase> {
  if (baseOid === null) {
    return EMPTY_TREE;
  }
  const [commit] = await repository.readCommits([baseOid], signal);
  return { kind: "commit", oid: commit.oid, subject: commit.subject };
}

function treeOf(trees: ReadonlyMap<string, string>, commitOid: string): string {
  const treeOid = trees.get(commitOid);
  if (treeOid === undefined || !isFullOid(treeOid)) {
    throw new HistoryOutputError(`Git did not report the tree of commit ${commitOid}.`);
  }
  return treeOid;
}

function replayTree(trees: ReadonlyMap<string, string>, commitOid: string | null): ReplayTree {
  if (commitOid === null) {
    return EMPTY_TREE;
  }
  return { kind: "commit", oid: commitOid, treeOid: treeOf(trees, commitOid) };
}
