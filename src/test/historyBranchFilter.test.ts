import { describe, expect, it } from "vitest";
import {
  branchFilterRef,
  CHECKED_OUT_BRANCH,
  headBranchFilter,
  isBranchChoice,
  isBranchFilterRef,
  isPickedBranch,
  resolveBranchChoice,
  resolveBranchFilter,
} from "../model/historyBranchFilter";
import type { HistoryData } from "../model/historyTypes";

const MAIN = "a".repeat(40);
const ORIGIN = "b".repeat(40);
const DETACHED = "c".repeat(40);
const UNLOADED = "d".repeat(40);

const HISTORY: HistoryData = {
  commits: [],
  refs: [
    { kind: "localBranch", name: "main", oid: MAIN },
    { kind: "remoteBranch", name: "origin/main", oid: ORIGIN },
    { kind: "localBranch", name: "origin/main", oid: MAIN },
    { kind: "tag", name: "main", oid: ORIGIN },
    { kind: "head", name: "HEAD", oid: DETACHED },
    { kind: "localBranch", name: "stale", oid: UNLOADED },
  ],
  head: null,
  isTruncated: false,
};

const isLoaded = (oid: string): boolean => oid !== UNLOADED;

describe("branchFilterRef", () => {
  it("names branches by their full ref and a detached HEAD as HEAD", () => {
    expect(branchFilterRef({ kind: "localBranch", name: "jimw/foo", oid: MAIN })).toBe("refs/heads/jimw/foo");
    expect(branchFilterRef({ kind: "remoteBranch", name: "origin/main", oid: MAIN })).toBe("refs/remotes/origin/main");
    expect(branchFilterRef({ kind: "head", name: "HEAD", oid: MAIN })).toBe("HEAD");
  });

  it("offers no filter for a tag", () => {
    expect(branchFilterRef({ kind: "tag", name: "v1", oid: MAIN })).toBeNull();
  });
});

describe("isBranchFilterRef", () => {
  it.each(["HEAD", "refs/heads/main", "refs/heads/jimw/foo-branch", "refs/remotes/origin/main"])("accepts %s", (value) => {
    expect(isBranchFilterRef(value)).toBe(true);
  });

  it.each(["", "main", "head", "refs/heads/", "refs/remotes/", "refs/tags/v1", MAIN])("rejects %j", (value) => {
    expect(isBranchFilterRef(value)).toBe(false);
  });
});

describe("resolveBranchFilter", () => {
  it("finds the ref's current tip, telling a local branch from a remote one of the same name", () => {
    expect(resolveBranchFilter(HISTORY, "refs/heads/main", isLoaded)).toEqual({ ref: "refs/heads/main", tipOid: MAIN });
    expect(resolveBranchFilter(HISTORY, "refs/remotes/origin/main", isLoaded)).toEqual({ ref: "refs/remotes/origin/main", tipOid: ORIGIN });
    expect(resolveBranchFilter(HISTORY, "refs/heads/origin/main", isLoaded)).toEqual({ ref: "refs/heads/origin/main", tipOid: MAIN });
    expect(resolveBranchFilter(HISTORY, "HEAD", isLoaded)).toEqual({ ref: "HEAD", tipOid: DETACHED });
  });

  it("is null for a missing ref, a tag or a tip that is not loaded", () => {
    expect(resolveBranchFilter(HISTORY, "refs/heads/gone", isLoaded)).toBeNull();
    expect(resolveBranchFilter(HISTORY, "refs/tags/main", isLoaded)).toBeNull();
    expect(resolveBranchFilter(HISTORY, "refs/heads/stale", isLoaded)).toBeNull();
    expect(resolveBranchFilter(null, "refs/heads/main", isLoaded)).toBeNull();
  });
});

describe("headBranchFilter", () => {
  it("filters by the checked-out local branch, not another ref sharing its tip or name", () => {
    const history: HistoryData = { ...HISTORY, head: { oid: MAIN, branch: "origin/main" } };

    expect(headBranchFilter(history, isLoaded)).toEqual({ ref: "refs/heads/origin/main", tipOid: MAIN });
  });

  it("filters a detached HEAD by its commit", () => {
    const history: HistoryData = { ...HISTORY, head: { oid: DETACHED, branch: null } };

    expect(headBranchFilter(history, isLoaded)).toEqual({ ref: "HEAD", tipOid: DETACHED });
  });

  it("is null for an unborn or unloaded HEAD", () => {
    expect(headBranchFilter({ ...HISTORY, head: null }, isLoaded)).toBeNull();
    expect(headBranchFilter({ ...HISTORY, head: { oid: UNLOADED, branch: "stale" } }, isLoaded)).toBeNull();
    expect(headBranchFilter(null, isLoaded)).toBeNull();
  });
});

describe("isBranchChoice", () => {
  it.each([CHECKED_OUT_BRANCH, "HEAD", "refs/heads/main"])("accepts %s", (value) => {
    expect(isBranchChoice(value)).toBe(true);
  });

  it.each(["", "main", "checked"])("rejects %j", (value) => {
    expect(isBranchChoice(value)).toBe(false);
  });
});

describe("isPickedBranch", () => {
  it("tells a picked ref from All branches and the checked-out branch", () => {
    expect(isPickedBranch("refs/heads/main")).toBe(true);
    expect(isPickedBranch(CHECKED_OUT_BRANCH)).toBe(false);
    expect(isPickedBranch(null)).toBe(false);
  });
});

describe("resolveBranchChoice", () => {
  const history: HistoryData = { ...HISTORY, head: { oid: MAIN, branch: "main" } };

  it("follows HEAD for the checked-out branch and resolves any other choice as a filter ref", () => {
    expect(resolveBranchChoice(history, CHECKED_OUT_BRANCH, isLoaded)).toEqual({ ref: "refs/heads/main", tipOid: MAIN });
    expect(resolveBranchChoice(history, "refs/remotes/origin/main", isLoaded)).toEqual({ ref: "refs/remotes/origin/main", tipOid: ORIGIN });
    expect(resolveBranchChoice(history, "refs/heads/gone", isLoaded)).toBeNull();
  });

  it("is null for All branches", () => {
    expect(resolveBranchChoice(history, null, isLoaded)).toBeNull();
  });
});
