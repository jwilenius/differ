import { describe, expect, it } from "vitest";
import { ResolutionController } from "../model/resolutionController";
import type { MergeDocument } from "../model/mergeDocument";

/** In-memory working copy, standing in for any host's editable document. */
class FakeDocument implements MergeDocument {
  readonly filePath = "/tmp/not-a-repo/f.txt";

  constructor(private text: string) {}

  getText(): string {
    return this.text;
  }

  async replaceLines(startLine: number, endLine: number, replacement: readonly string[]): Promise<boolean> {
    const lines = this.text.split("\n");
    lines.splice(startLine, endLine - startLine + 1, ...replacement);
    this.text = lines.join("\n");
    return true;
  }
}

const conflicted = ["a", "<<<<<<< HEAD", "MINE", "=======", "THEIRS", ">>>>>>> trunk", "z"].join("\n");

describe("ResolutionController editing", () => {
  it("replaces the text of a line", async () => {
    const document = new FakeDocument("a\nb\nc");
    const controller = new ResolutionController(document);

    expect(await controller.editLine(1, "EDITED")).toBe(true);
    expect(document.getText()).toBe("a\nEDITED\nc");
  });

  it("splits a line at the cursor", async () => {
    const document = new FakeDocument("a\nhello world\nc");
    const controller = new ResolutionController(document);

    expect(await controller.splitLine(1, 5)).toBe(true);
    expect(document.getText()).toBe("a\nhello\n world\nc");
  });

  it("clamps a split offset past the end of the line", async () => {
    const document = new FakeDocument("ab");
    const controller = new ResolutionController(document);

    await controller.splitLine(0, 99);
    expect(document.getText()).toBe("ab\n");
  });

  it("joins a line onto the previous one", async () => {
    const document = new FakeDocument("a\nhello\nworld");
    const controller = new ResolutionController(document);

    expect(await controller.joinWithPrevious(2)).toBe(true);
    expect(document.getText()).toBe("a\nhelloworld");
  });

  it("refuses to join the first line upwards", async () => {
    const document = new FakeDocument("a\nb");
    const controller = new ResolutionController(document);

    expect(await controller.joinWithPrevious(0)).toBe(false);
    expect(document.getText()).toBe("a\nb");
  });

  it("refuses to edit a conflict marker line", async () => {
    const document = new FakeDocument(conflicted);
    const controller = new ResolutionController(document);

    expect(await controller.editLine(1, "tampered")).toBe(false);
    expect(await controller.splitLine(3, 2)).toBe(false);
    expect(document.getText()).toBe(conflicted);
  });

  it("allows editing the content between markers", async () => {
    const document = new FakeDocument(conflicted);
    const controller = new ResolutionController(document);

    expect(await controller.editLine(2, "MINE, tweaked")).toBe(true);
    expect(document.getText()).toContain("MINE, tweaked");
  });

  it("refuses to join a line onto a marker", async () => {
    const document = new FakeDocument(conflicted);
    const controller = new ResolutionController(document);

    expect(await controller.joinWithPrevious(2)).toBe(false);
  });

  it("rejects line numbers outside the document", async () => {
    const controller = new ResolutionController(new FakeDocument("a"));

    expect(await controller.editLine(9, "x")).toBe(false);
    expect(await controller.editLine(-1, "x")).toBe(false);
  });

  it("resolves a conflict through the same document port", async () => {
    const document = new FakeDocument(conflicted);
    const controller = new ResolutionController(document);

    expect(await controller.resolve(0, "local")).toBe("applied");
    expect(document.getText()).toBe("a\nMINE\nz");
  });

  it("reports a conflict that has already gone", async () => {
    const controller = new ResolutionController(new FakeDocument("a\nb"));

    expect(await controller.resolve(0, "local")).toBe("gone");
  });
});

const splittable = [
  "a",
  "<<<<<<< HEAD",
  "mine-1",
  "shared",
  "mine-2",
  "=======",
  "theirs-1",
  "shared",
  "theirs-2",
  ">>>>>>> trunk",
  "z",
].join("\n");

describe("ResolutionController hunk splitting", () => {
  it("divides a conflict into separately decidable pieces", () => {
    const controller = new ResolutionController(new FakeDocument(splittable));

    const hunks = controller.hunksFor(0);

    expect(hunks.map((hunk) => hunk.isCommon)).toEqual([false, true, false]);
    expect(hunks[0].ours).toEqual(["mine-1"]);
    expect(hunks[0].theirs).toEqual(["theirs-1"]);
  });

  it("keeps only the agreed lines when nothing is ticked", async () => {
    const document = new FakeDocument(splittable);
    const controller = new ResolutionController(document);

    expect(await controller.applySelection(0)).toBe("applied");
    expect(document.getText()).toBe(["a", "shared", "z"].join("\n"));
  });

  it("takes one side of one piece and the other side of another", async () => {
    const document = new FakeDocument(splittable);
    const controller = new ResolutionController(document);

    controller.toggleHunk(0, 0, "ours");
    controller.toggleHunk(0, 2, "theirs");

    expect(await controller.applySelection(0)).toBe("applied");
    expect(document.getText()).toBe(["a", "mine-1", "shared", "theirs-2", "z"].join("\n"));
  });

  it("drops a piece that is ticked twice", async () => {
    const document = new FakeDocument(splittable);
    const controller = new ResolutionController(document);

    controller.toggleHunk(0, 0, "ours");
    controller.toggleHunk(0, 0, "ours");

    expect(await controller.applySelection(0)).toBe("applied");
    expect(document.getText()).toBe(["a", "shared", "z"].join("\n"));
  });

  it("takes a whole side by ticking all of its pieces", async () => {
    const document = new FakeDocument(splittable);
    const controller = new ResolutionController(document);

    controller.toggleSide(0, "ours", true);

    expect(await controller.applySelection(0)).toBe("applied");
    expect(document.getText()).toBe(["a", "mine-1", "shared", "mine-2", "z"].join("\n"));
  });

  it("reports a conflict that is already gone", async () => {
    const controller = new ResolutionController(new FakeDocument("a\nb\n"));

    expect(await controller.applySelection(0)).toBe("gone");
  });

  it("keeps a pending selection pointed at its conflict when an earlier one is resolved", async () => {
    const document = new FakeDocument([splittable, splittable].join("\n"));
    const controller = new ResolutionController(document);

    controller.toggleHunk(1, 0, "ours");
    expect(await controller.resolve(0, "local")).toBe("applied");

    // The second conflict is now the first, and its selection moved with it.
    expect(await controller.applySelection(0)).toBe("applied");
    expect(document.getText()).toContain("mine-1");
    expect(document.getText()).not.toContain("theirs-1");
  });
});
