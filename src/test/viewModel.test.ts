import { describe, expect, it } from "vitest";
import { buildMergeView } from "../view/viewModel";

const options = { wordLevelHighlighting: true };

const document = [
  "line one",
  "<<<<<<< HEAD",
  "mine",
  "||||||| base",
  "original",
  "=======",
  "theirs",
  ">>>>>>> feature",
  "line last",
].join("\n");

describe("buildMergeView", () => {
  it("renders context lines plus the conflict rows", () => {
    const model = buildMergeView(document, options);

    expect(model.rows[0].local.text).toBe("line one");
    expect(model.rows[model.rows.length - 1].local.text).toBe("line last");
  });

  it("summarises each conflict with its row span and labels", () => {
    const model = buildMergeView(document, options);

    expect(model.conflicts).toHaveLength(1);
    const conflict = model.conflicts[0];
    expect(conflict.localLabel).toBe("HEAD");
    expect(conflict.remoteLabel).toBe("feature");
    expect(conflict.rowEnd).toBeGreaterThan(conflict.rowStart);
  });

  it("marks the conflicting rows as a conflict", () => {
    const model = buildMergeView(document, options);
    const conflict = model.conflicts[0];

    const kinds = model.rows.slice(conflict.rowStart, conflict.rowEnd).map((row) => row.kind);
    expect(kinds).toContain("conflict");
  });

  it("numbers lines continuously across sections and per pane", () => {
    const model = buildMergeView(document, options);
    const lastRow = model.rows[model.rows.length - 1];

    // local: "line one", "mine", "line last"; base: "line one", "original", "line last"
    expect(lastRow.local.lineNumber).toBe(2);
    expect(lastRow.base.lineNumber).toBe(2);
    expect(lastRow.remote.lineNumber).toBe(2);
  });

  it("returns no conflicts for a clean file", () => {
    const model = buildMergeView("a\nb\nc", options);

    expect(model.conflicts).toHaveLength(0);
    expect(model.rows).toHaveLength(3);
  });
});
