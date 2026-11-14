import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listConflictedFiles, markResolved } from "../git/gitConflictedFiles";
import { createConflictRepository, divergeBranches, mergeFeature, runGit } from "./gitConflictFixture";

let repo: string;

beforeEach(() => {
  repo = createConflictRepository();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("listConflictedFiles", () => {
  it("lists each conflicted file once, as an absolute path, including unusual names", async () => {
    divergeBranches(repo, ["a.txt", "src/b c.ts", "src/tab\there.md"]);
    mergeFeature(repo);

    const files = await listConflictedFiles(repo);

    expect([...files].sort()).toEqual(["a.txt", "src/b c.ts", "src/tab\there.md"].map((name) => path.join(repo, name)));
  });

  it("drops a file once it is staged and returns nothing without a merge", async () => {
    divergeBranches(repo, ["a.txt", "b.txt"]);

    expect(await listConflictedFiles(repo)).toEqual([]);

    mergeFeature(repo);
    runGit(repo, "add", "a.txt");

    expect(await listConflictedFiles(repo)).toEqual([path.join(repo, "b.txt")]);
  });
});

describe("markResolved", () => {
  it("stages only the named file, even when its name looks like a pattern", async () => {
    divergeBranches(repo, ["app/[id].tsx", "app/i.tsx", "app/d.tsx"]);
    mergeFeature(repo);

    await markResolved(path.join(repo, "app/[id].tsx"));

    expect([...(await listConflictedFiles(repo))].sort()).toEqual([path.join(repo, "app/d.tsx"), path.join(repo, "app/i.tsx")]);
  });
});
