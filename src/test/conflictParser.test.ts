import { describe, expect, it } from "vitest";
import { hasConflictMarkers } from "../core/conflictParser";

describe("hasConflictMarkers", () => {
  it("does not treat a line of angle brackets as a marker", () => {
    expect(hasConflictMarkers("<<<<<<<<<<<< decorative")).toBe(false);
    expect(hasConflictMarkers("<<<<<<< HEAD")).toBe(true);
  });
});
