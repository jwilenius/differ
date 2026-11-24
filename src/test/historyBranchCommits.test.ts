import { describe, expect, it } from "vitest";
import { selectBranchAction, selectBranchTarget } from "../model/historyBranchCommits";
import type { BranchCommits, SelectBranchTarget } from "../model/historyBranchCommits";
import { CHECKED_OUT_BRANCH } from "../model/historyBranchFilter";
import type { HistoryData } from "../model/historyTypes";
import { STAGED_CHANGES_ID, UNSTAGED_CHANGES_ID } from "../model/historyWorkingChanges";

const MAIN = "a".repeat(40);
const FEATURE = "b".repeat(40);
const OLDER = "c".repeat(40);
const UNLOADED = "d".repeat(40);

const HISTORY: HistoryData = {
  commits: [],
  refs: [
    { kind: "localBranch", name: "main", oid: MAIN },
    { kind: "localBranch", name: "feature", oid: FEATURE },
  ],
  head: { oid: FEATURE, branch: "feature" },
  isTruncated: false,
};

const isLoaded = (oid: string): boolean => oid !== UNLOADED;

const FEATURE_TARGET: SelectBranchTarget = { ref: "refs/heads/feature", isCheckedOut: true };
const WORKING_IDS = [STAGED_CHANGES_ID, UNSTAGED_CHANGES_ID] as const;

function commitsBeyond(base: string, oids: readonly string[], isUpstream = false): BranchCommits {
  return { kind: "commits", branch: "feature", base, isUpstream, oids };
}

describe("selectBranchTarget", () => {
  it("targets the checked-out branch when no branch is picked", () => {
    expect(selectBranchTarget(HISTORY, null, null, isLoaded)).toEqual(FEATURE_TARGET);
    expect(selectBranchTarget(HISTORY, CHECKED_OUT_BRANCH, { ref: "refs/heads/feature", tipOid: FEATURE }, isLoaded))
      .toEqual(FEATURE_TARGET);
  });

  it("targets a picked branch, checked out only when it is HEAD's branch", () => {
    const main = { ref: "refs/heads/main", tipOid: MAIN };
    const feature = { ref: "refs/heads/feature", tipOid: FEATURE };

    expect(selectBranchTarget(HISTORY, "refs/heads/main", main, isLoaded))
      .toEqual({ ref: "refs/heads/main", isCheckedOut: false });
    expect(selectBranchTarget(HISTORY, "refs/heads/feature", feature, isLoaded)).toEqual(FEATURE_TARGET);
  });

  it("falls back to the checked-out branch while a picked branch does not resolve", () => {
    expect(selectBranchTarget(HISTORY, "refs/heads/gone", null, isLoaded)).toEqual(FEATURE_TARGET);
  });

  it("targets a detached HEAD by HEAD", () => {
    const history: HistoryData = {
      ...HISTORY,
      refs: [...HISTORY.refs, { kind: "head", name: "HEAD", oid: MAIN }],
      head: { oid: MAIN, branch: null },
    };

    expect(selectBranchTarget(history, null, null, isLoaded)).toEqual({ ref: "HEAD", isCheckedOut: true });
  });

  it("has no target without a loaded HEAD", () => {
    expect(selectBranchTarget(null, null, null, isLoaded)).toBeNull();
    expect(selectBranchTarget({ ...HISTORY, head: null }, null, null, isLoaded)).toBeNull();
  });
});

describe("selectBranchAction", () => {
  it("selects the working changes first, then the branch's loaded commits", () => {
    const action = selectBranchAction(FEATURE_TARGET, commitsBeyond("main", [FEATURE, OLDER]), WORKING_IDS, isLoaded);

    expect(action).toEqual({
      ids: [STAGED_CHANGES_ID, UNSTAGED_CHANGES_ID, FEATURE, OLDER],
      unloadedCount: 0,
      title: "Select every commit on feature that is not on main, plus uncommitted changes",
    });
  });

  it("leaves the working changes out for a branch that is not checked out", () => {
    const target = { ref: "refs/heads/feature", isCheckedOut: false };

    const action = selectBranchAction(target, commitsBeyond("main", [FEATURE]), WORKING_IDS, isLoaded);

    expect(action).toEqual({ ids: [FEATURE], unloadedCount: 0, title: "Select every commit on feature that is not on main" });
  });

  it("names unpushed commits when the base is the upstream", () => {
    const target = { ref: "refs/heads/main", isCheckedOut: true };

    const action = selectBranchAction(target, commitsBeyond("origin/main", [MAIN], true), [], isLoaded);

    expect(action.title).toBe("Select commits on main not yet pushed to origin/main");
  });

  it("counts commits older than the loaded history without selecting them", () => {
    const action = selectBranchAction(FEATURE_TARGET, commitsBeyond("main", [FEATURE, UNLOADED]), [], isLoaded);

    expect(action.ids).toEqual([FEATURE]);
    expect(action.unloadedCount).toBe(1);
  });

  it("selects only the working changes of a branch with no commits beyond its base, and says so", () => {
    const action = selectBranchAction(FEATURE_TARGET, commitsBeyond("main", []), [UNSTAGED_CHANGES_ID], isLoaded);

    expect(action).toEqual({
      ids: [UNSTAGED_CHANGES_ID],
      unloadedCount: 0,
      title: "Select only the uncommitted changes: feature has no commits beyond main",
    });
  });

  it("selects only the working changes when the branch's commits are not loaded, and says so", () => {
    const action = selectBranchAction(FEATURE_TARGET, commitsBeyond("main", [UNLOADED]), [UNSTAGED_CHANGES_ID], isLoaded);

    expect(action).toEqual({
      ids: [UNSTAGED_CHANGES_ID],
      unloadedCount: 1,
      title: "Select only the uncommitted changes: the commits on feature beyond main are not in the loaded history",
    });
  });

  it("is disabled with nothing to select", () => {
    const action = selectBranchAction(FEATURE_TARGET, commitsBeyond("main", []), [], isLoaded);

    expect(action).toEqual({ ids: [], unloadedCount: 0, title: "No commits on feature beyond main" });
  });

  it("is disabled, naming the unloaded history, when none of the branch's commits is loaded", () => {
    const action = selectBranchAction(FEATURE_TARGET, commitsBeyond("main", [UNLOADED]), [], isLoaded);

    expect(action).toEqual({ ids: [], unloadedCount: 0, title: "The commits on feature beyond main are not in the loaded history" });
  });

  it.each([
    [{ kind: "reading" } as const, "Finding the commits on feature…"],
    [{ kind: "failed" } as const, "Could not find the commits on feature; the jw-differ History output has details"],
    [{ kind: "noDefaultBranch", branch: "feature" } as const, "No default branch found: there is no origin/HEAD, main or master"],
    [{ kind: "noUpstream", branch: "feature" } as const, "feature has no upstream branch to find unpushed commits against"],
  ])("is disabled while the commits are %j", (lookup, title) => {
    expect(selectBranchAction(FEATURE_TARGET, lookup, WORKING_IDS, isLoaded)).toEqual({ ids: [], unloadedCount: 0, title });
  });

  it("is disabled without a target", () => {
    expect(selectBranchAction(null, { kind: "reading" }, WORKING_IDS, isLoaded))
      .toEqual({ ids: [], unloadedCount: 0, title: "No checked-out commit to select a branch from" });
  });
});
