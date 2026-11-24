import { describe, expect, it } from "vitest";
import {
  describeSelectedChanges,
  presentWorkingChangeIds,
  STAGED_CHANGES_ID,
  UNSTAGED_CHANGES_ID,
} from "../model/historyWorkingChanges";
import type { WorkingChangeSummary } from "../model/historyWorkingChanges";

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);

function summary(staged: number, unstaged: number): WorkingChangeSummary {
  return { staged, unstaged, untracked: 0, conflicted: 0, isTruncated: false };
}

describe("presentWorkingChangeIds", () => {
  it("lists the rows with changes in replay order", () => {
    expect(presentWorkingChangeIds(summary(1, 2))).toEqual([STAGED_CHANGES_ID, UNSTAGED_CHANGES_ID]);
    expect(presentWorkingChangeIds(summary(0, 2))).toEqual([UNSTAGED_CHANGES_ID]);
    expect(presentWorkingChangeIds(summary(0, 0))).toEqual([]);
    expect(presentWorkingChangeIds(null)).toEqual([]);
  });
});

describe("describeSelectedChanges", () => {
  it("counts commits and names the working changes", () => {
    expect(describeSelectedChanges([C1, C2])).toBe("2 selected commits");
    expect(describeSelectedChanges([STAGED_CHANGES_ID])).toBe("staged changes");
    expect(describeSelectedChanges([UNSTAGED_CHANGES_ID])).toBe("unstaged changes");
    expect(describeSelectedChanges([UNSTAGED_CHANGES_ID, STAGED_CHANGES_ID])).toBe("staged and unstaged changes");
    expect(describeSelectedChanges([C1, STAGED_CHANGES_ID])).toBe("1 selected commit and staged changes");
  });
});
