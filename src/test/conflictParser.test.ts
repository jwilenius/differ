import { describe, expect, it } from "vitest";
import { hasConflictMarkers, parseConflicts } from "../core/conflictParser";
import type { ConflictSection } from "../core/types";

const diff3Document = [
  "const a = 1;",
  "<<<<<<< HEAD",
  "const b = 2;",
  "||||||| merged common ancestors",
  "const b = 0;",
  "=======",
  "const b = 3;",
  ">>>>>>> feature",
  "const c = 4;",
].join("\n");

describe("parseConflicts", () => {
  it("splits a diff3 document into stable and conflict sections", () => {
    const sections = parseConflicts(diff3Document);

    expect(sections.map((section) => section.kind)).toEqual(["stable", "conflict", "stable"]);
  });

  it("captures all three sides of a diff3 conflict", () => {
    const conflict = parseConflicts(diff3Document)[1] as ConflictSection;

    expect(conflict.local).toEqual(["const b = 2;"]);
    expect(conflict.base).toEqual(["const b = 0;"]);
    expect(conflict.remote).toEqual(["const b = 3;"]);
    expect(conflict.hasBase).toBe(true);
  });

  it("records the branch labels and marker line numbers", () => {
    const conflict = parseConflicts(diff3Document)[1] as ConflictSection;

    expect(conflict.localLabel).toBe("HEAD");
    expect(conflict.remoteLabel).toBe("feature");
    expect(conflict.markerStartLine).toBe(1);
    expect(conflict.markerEndLine).toBe(7);
  });

  it("treats base as empty for 2-way markers", () => {
    const text = ["<<<<<<< HEAD", "mine", "=======", "theirs", ">>>>>>> other"].join("\n");

    const conflict = parseConflicts(text)[0] as ConflictSection;

    expect(conflict.hasBase).toBe(false);
    expect(conflict.base).toEqual([]);
    expect(conflict.local).toEqual(["mine"]);
    expect(conflict.remote).toEqual(["theirs"]);
  });

  it("finds every conflict in a document with several", () => {
    const text = [diff3Document, diff3Document].join("\n");

    const conflicts = parseConflicts(text).filter((section) => section.kind === "conflict");

    expect(conflicts).toHaveLength(2);
  });

  it("ignores an unterminated conflict", () => {
    const text = ["<<<<<<< HEAD", "mine", "no end marker"].join("\n");

    const sections = parseConflicts(text);

    expect(sections.every((section) => section.kind === "stable")).toBe(true);
  });

  it("does not treat a line of angle brackets as a marker", () => {
    expect(hasConflictMarkers("<<<<<<<<<<<< decorative")).toBe(false);
    expect(hasConflictMarkers("<<<<<<< HEAD")).toBe(true);
  });
});
