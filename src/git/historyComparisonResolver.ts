import type {
  ComparisonRequest,
  EmptyTreeBase,
  HistoryCommit,
  IndexBase,
  MainlineChoice,
  NeedsBaseResult,
  ResolvedBase,
} from "../model/historyTypes";
import { isWorkingChangeId, STAGED_CHANGES_ID, WORKING_CHANGE_REPLAY_ORDER } from "../model/historyWorkingChanges";
import type { WorkingChangeId } from "../model/historyWorkingChanges";
import { HistoryOutputError, isFullOid } from "./gitHistoryRepository";
import type { AncestryEntry, GitHistoryRepository } from "./gitHistoryRepository";

const EMPTY_TREE: EmptyTreeBase = { kind: "emptyTree" };
const INDEX: IndexBase = { kind: "index" };

/** A commit together with the tree it records. */
export interface CommitTree {
  readonly kind: "commit";
  readonly oid: string;
  readonly treeOid: string;
}

/** HEAD's tree, or the empty tree while HEAD is unborn. */
export type HeadTree = CommitTree | EmptyTreeBase;

/** Where a patch or the comparison starts: a commit's tree, the empty tree for roots, or the index's tree. */
export type ReplayTree = HeadTree | IndexBase;

/** One selected commit's patch: `parent` tree → commit tree. */
export interface ReplayStep {
  readonly oid: string;
  readonly treeOid: string;
  /** The chosen mainline parent, or the empty tree for a root commit. */
  readonly parent: ReplayTree;
}

/** Selected working changes, replayed after every selected commit: HEAD → index, then index → files on disk. */
export interface WorkingReplay {
  /** What staged changes are taken against. */
  readonly headTree: HeadTree;
  /** Selected working changes, staged before unstaged. */
  readonly ids: readonly WorkingChangeId[];
}

/** One reproducible interpretation of a request: what to start from and which patches to apply in order. */
export interface ResolvedHistoryComparison {
  readonly kind: "resolved";
  readonly base: ResolvedBase;
  readonly baseTree: ReplayTree;
  /** Selected commits in Git's topological replay order, oldest first. */
  readonly steps: readonly ReplayStep[];
  /** Null when no working change is selected. */
  readonly working: WorkingReplay | null;
}

export type HistoryComparisonResolution = ResolvedHistoryComparison | NeedsBaseResult;

/** Loaded commit → its parents, as a history load read them; commits never change, so any load's entries hold. */
export type LoadedParents = ReadonlyMap<string, readonly string[]>;

const NO_LOADED_PARENTS: LoadedParents = new Map();

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
  /**
   * Selected commits with no selected ancestor, in the same order, then the first selected working change when no
   * selected commit is HEAD or one of its ancestors.
   */
  readonly minimumOids: readonly string[];
}

/** Which commits and working changes a request selects, plus HEAD when working changes need it. */
interface Selection {
  readonly oids: readonly string[];
  readonly workingIds: readonly WorkingChangeId[];
  /** Null while HEAD is unborn or when no working change is selected. */
  readonly headOid: string | null;
}

/** Where the comparison starts before its tree is known. */
type BaseSource = { readonly kind: "commit"; readonly oid: string } | EmptyTreeBase | IndexBase;

/**
 * Decides base, replay order and each selected commit's patch parent, independent of how the selection was made.
 * Several earliest commits under an Automatic base need an explicit base instead of a guess. Working changes sit on
 * top of HEAD and replay last; `loadedParents` tells where HEAD is without walking its history when it can.
 */
export async function resolveHistoryComparison(
  repository: GitHistoryRepository,
  request: ComparisonRequest,
  signal: AbortSignal,
  loadedParents: LoadedParents = NO_LOADED_PARENTS,
): Promise<HistoryComparisonResolution> {
  const selection = await readSelection(repository, request, signal);
  const commits = await repository.readCommits(selection.oids, signal);
  await assertParentsAvailable(repository, selection.oids, signal);
  const parentOids = chooseParents(commits, request.mainlines);

  const order = await readSelectionOrder(repository, selection, loadedParents, signal);
  const isBaseAmbiguous = request.base.kind === "automatic" && order.minimumOids.length > 1;
  if (isBaseAmbiguous) {
    return { kind: "needsBase", minimumOids: order.minimumOids };
  }

  const baseSource = request.base.kind === "pinned"
    ? { kind: "commit", oid: request.base.oid } as const
    : automaticBase(order.minimumOids[0]!, parentOids, selection.headOid);
  const base = await resolveBase(repository, baseSource, signal);
  const baseOids = baseSource.kind === "commit" ? [baseSource.oid] : [];
  const headOids = selection.headOid === null ? [] : [selection.headOid];
  const treeCommitOids = [...selection.oids, ...parentOids.values(), ...baseOids, ...headOids];
  const trees = await repository.readTreeOids(treeCommitOids, signal);
  return { kind: "resolved", base, ...replayTrees(trees, { selection, order, parentOids, baseSource }) };
}

/** Everything a replay reads, with each commit resolved to its tree. */
function replayTrees(
  trees: ReadonlyMap<string, string>,
  plan: {
    readonly selection: Selection;
    readonly order: SelectionOrder;
    readonly parentOids: ReadonlyMap<string, string>;
    readonly baseSource: BaseSource;
  },
): Pick<ResolvedHistoryComparison, "baseTree" | "steps" | "working"> {
  const { selection, order, parentOids, baseSource } = plan;
  const steps = order.orderedOids.map((oid): ReplayStep => ({
    oid,
    treeOid: treeOf(trees, oid),
    parent: commitTree(trees, parentOids.get(oid) ?? null),
  }));
  const baseTree = baseSource.kind === "commit" ? commitTree(trees, baseSource.oid) : baseSource;
  const working = selection.workingIds.length === 0
    ? null
    : { headTree: commitTree(trees, selection.headOid), ids: selection.workingIds };
  return { baseTree, steps, working };
}

async function readSelection(
  repository: GitHistoryRepository,
  request: ComparisonRequest,
  signal: AbortSignal,
): Promise<Selection> {
  const selectedIds = [...new Set(request.selectedOids)];
  if (selectedIds.length === 0) {
    throw new HistoryComparisonError("Select at least one commit to compare.", "emptySelection");
  }

  const workingIds = WORKING_CHANGE_REPLAY_ORDER.filter((id) => selectedIds.includes(id));
  const oids = selectedIds.filter((id) => !isWorkingChangeId(id));
  const headOid = workingIds.length === 0 ? null : await repository.readHeadOid(signal);
  return { oids, workingIds, headOid };
}

/**
 * What Automatic starts from for the single earliest selected item: a commit's chosen parent (the empty tree for a
 * root), HEAD for staged changes, and the index for unstaged changes alone.
 */
function automaticBase(
  minimumId: string,
  parentOids: ReadonlyMap<string, string>,
  headOid: string | null,
): BaseSource {
  if (!isWorkingChangeId(minimumId)) {
    const parentOid = parentOids.get(minimumId);
    return parentOid === undefined ? EMPTY_TREE : { kind: "commit", oid: parentOid };
  }
  if (minimumId !== STAGED_CHANGES_ID) {
    return INDEX;
  }
  return headOid === null ? EMPTY_TREE : { kind: "commit", oid: headOid };
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
      + "Deepen the history with Git outside jw-differ, then compare again.";
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
 * parent path, through selected or unselected commits, reaches another selected commit. Working changes are children
 * of HEAD, so they are a minimum when HEAD reaches no selected commit.
 */
async function readSelectionOrder(
  repository: GitHistoryRepository,
  selection: Selection,
  loadedParents: LoadedParents,
  signal: AbortSignal,
): Promise<SelectionOrder> {
  const workingMinimum = selection.workingIds.slice(0, 1);
  if (selection.oids.length === 0) {
    return { orderedOids: [], minimumOids: workingMinimum };
  }

  // Lexically sorted input makes Git's order between unrelated commits independent of selection order.
  const selected = new Set(selection.oids);
  const ancestry = await repository.readAncestry([...selection.oids].sort(), signal);
  const { orderedOids, minimumOids } = walkAncestry(ancestry, selected);
  const isHeadOnSelection = selection.headOid !== null
    && await headReachesSelection(repository, selection.headOid, selected, loadedParents, signal);
  return { orderedOids, minimumOids: isHeadOnSelection ? minimumOids : [...minimumOids, ...workingMinimum] };
}

/** Whether HEAD is selected or descends from a selected commit; Git walks HEAD's history only when the load cannot tell. */
async function headReachesSelection(
  repository: GitHistoryRepository,
  headOid: string,
  selected: ReadonlySet<string>,
  loadedParents: LoadedParents,
  signal: AbortSignal,
): Promise<boolean> {
  const loadedAnswer = loadedReach(headOid, selected, loadedParents);
  if (loadedAnswer !== undefined) {
    return loadedAnswer;
  }
  const ancestry = await repository.readAncestry([headOid], signal);
  return ancestry.some((entry) => selected.has(entry.oid));
}

/** Searches the loaded ancestors of `headOid` for a selected commit; undefined once it reaches one not loaded. */
function loadedReach(headOid: string, selected: ReadonlySet<string>, loadedParents: LoadedParents): boolean | undefined {
  const seen = new Set([headOid]);
  const pending = [headOid];
  for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
    if (selected.has(oid)) {
      return true;
    }
    const parents = loadedParents.get(oid);
    if (parents === undefined) {
      return undefined;
    }
    for (const parent of parents.filter((candidate) => !seen.has(candidate))) {
      seen.add(parent);
      pending.push(parent);
    }
  }
  return false;
}

function walkAncestry(ancestry: readonly AncestryEntry[], selected: ReadonlySet<string>): SelectionOrder {
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
  source: BaseSource,
  signal: AbortSignal,
): Promise<ResolvedBase> {
  if (source.kind !== "commit") {
    return source;
  }
  const [commit] = await repository.readCommits([source.oid], signal);
  return { kind: "commit", oid: commit.oid, subject: commit.subject };
}

function treeOf(trees: ReadonlyMap<string, string>, commitOid: string): string {
  const treeOid = trees.get(commitOid);
  if (treeOid === undefined || !isFullOid(treeOid)) {
    throw new HistoryOutputError(`Git did not report the tree of commit ${commitOid}.`);
  }
  return treeOid;
}

function commitTree(trees: ReadonlyMap<string, string>, commitOid: string | null): HeadTree {
  if (commitOid === null) {
    return EMPTY_TREE;
  }
  return { kind: "commit", oid: commitOid, treeOid: treeOf(trees, commitOid) };
}
