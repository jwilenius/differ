import { describe, expect, it } from "vitest";
import { parseConflicts } from "../core/conflictParser";
import { assembleHunks, hunkAnchors, splitConflict } from "../model/hunkSplitter";
import type { ConflictSection } from "../core/types";

/** Builds the conflict a marker block describes, the way a working copy holds it. */
function conflictFrom(lines: readonly string[]): ConflictSection {
  const section = parseConflicts(lines.join("\n")).find((it) => it.kind === "conflict");
  if (!section || section.kind !== "conflict") {
    throw new Error("expected a conflict");
  }
  return section;
}

const takeNothing = () => false;
const takeAll = () => true;

describe("splitConflict", () => {
  it("splits a conflict into the pieces that actually differ", () => {
    const conflict = conflictFrom([
      "<<<<<<< HEAD",
      "same-top",
      "mine",
      "same-bottom",
      "=======",
      "same-top",
      "theirs",
      "same-bottom",
      ">>>>>>> trunk",
    ]);

    const hunks = splitConflict(conflict);
    const divided = hunks.filter((hunk) => !hunk.isCommon);

    expect(divided).toHaveLength(1);
    expect(divided[0].ours).toEqual(["mine"]);
    expect(divided[0].theirs).toEqual(["theirs"]);
    expect(hunks.filter((hunk) => hunk.isCommon).map((hunk) => hunk.common)).toEqual([
      ["same-top"],
      ["same-bottom"],
    ]);
  });

  it("finds several independently decidable pieces in one conflict", () => {
    const conflict = conflictFrom([
      "<<<<<<< HEAD",
      "mine-1",
      "shared",
      "mine-2",
      "=======",
      "theirs-1",
      "shared",
      "theirs-2",
      ">>>>>>> trunk",
    ]);

    const divided = splitConflict(conflict).filter((hunk) => !hunk.isCommon);

    expect(divided).toHaveLength(2);
    expect(divided.map((hunk) => hunk.ours)).toEqual([["mine-1"], ["mine-2"]]);
    expect(divided.map((hunk) => hunk.theirs)).toEqual([["theirs-1"], ["theirs-2"]]);
  });

  it("treats an identical change on both sides as settled, not divided", () => {
    const conflict = conflictFrom([
      "<<<<<<< HEAD",
      "agreed",
      "||||||| base",
      "old",
      "=======",
      "agreed",
      ">>>>>>> trunk",
    ]);

    const hunks = splitConflict(conflict);

    expect(hunks.filter((hunk) => !hunk.isCommon)).toHaveLength(0);
    expect(assembleHunks(hunks, takeNothing)).toEqual(["agreed"]);
  });
});

describe("assembleHunks", () => {
  const conflict = conflictFrom([
    "<<<<<<< HEAD",
    "mine-1",
    "shared",
    "mine-2",
    "=======",
    "theirs-1",
    "shared",
    "theirs-2",
    ">>>>>>> trunk",
  ]);
  const hunks = splitConflict(conflict);

  it("keeps agreed content whatever is selected", () => {
    expect(assembleHunks(hunks, takeNothing)).toEqual(["shared"]);
  });

  it("takes one side of one piece and the other side of another", () => {
    const lines = assembleHunks(hunks, (hunkIndex, side) =>
      hunkIndex === 0 ? side === "ours" : side === "theirs");

    expect(lines).toEqual(["mine-1", "shared", "theirs-2"]);
  });

  it("orders both sides of a piece branch-first when both are taken", () => {
    expect(assembleHunks(hunks, takeAll)).toEqual([
      "mine-1",
      "theirs-1",
      "shared",
      "mine-2",
      "theirs-2",
    ]);
  });
});

describe("hunkAnchors", () => {
  it("points at the working-copy lines each piece governs", () => {
    const conflict = conflictFrom([
      "<<<<<<< HEAD", // line 0
      "mine-1", //       line 1
      "shared", //       line 2
      "mine-2", //       line 3
      "=======", //      line 4
      "theirs-1", //     line 5
      "shared", //       line 6
      "theirs-2", //     line 7
      ">>>>>>> trunk", //line 8
    ]);

    const anchors = hunkAnchors(conflict, splitConflict(conflict));

    expect(anchors.map(({ side, startLine, lineCount }) => ({ side, startLine, lineCount }))).toEqual([
      { side: "ours", startLine: 1, lineCount: 1 },
      { side: "theirs", startLine: 5, lineCount: 1 },
      { side: "ours", startLine: 3, lineCount: 1 },
      { side: "theirs", startLine: 7, lineCount: 1 },
    ]);
  });

  it("skips the base block when locating the incoming side", () => {
    const conflict = conflictFrom([
      "<<<<<<< HEAD", // line 0
      "mine", //         line 1
      "||||||| base", // line 2
      "old", //          line 3
      "=======", //      line 4
      "theirs", //       line 5
      ">>>>>>> trunk", //line 6
    ]);

    const anchors = hunkAnchors(conflict, splitConflict(conflict));

    expect(anchors.find((anchor) => anchor.side === "theirs")?.startLine).toBe(5);
  });

  it("offers no control for a side that contributes no lines", () => {
    const conflict = conflictFrom(["<<<<<<< HEAD", "mine", "=======", ">>>>>>> trunk"]);

    const anchors = hunkAnchors(conflict, splitConflict(conflict));

    expect(anchors.map((anchor) => anchor.side)).toEqual(["ours"]);
  });
});
