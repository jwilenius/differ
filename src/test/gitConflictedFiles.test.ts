import * as fs from "node:fs";
import * as os from "node:os";
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

  it("leaves out conflicts the merge view cannot open: a deleted side or a symbolic link", async () => {
    fs.writeFileSync(path.join(repo, "both.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "deleted.txt"), "base\n");
    fs.symlinkSync("base-target", path.join(repo, "link"));
    runGit(repo, "add", ".");
    runGit(repo, "commit", "-qm", "base");
    runGit(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "both.txt"), "feature\n");
    runGit(repo, "rm", "-q", "deleted.txt");
    replaceLink(path.join(repo, "link"), "feature-target");
    runGit(repo, "commit", "-qam", "feature");
    runGit(repo, "checkout", "-q", "trunk");
    fs.writeFileSync(path.join(repo, "both.txt"), "trunk\n");
    fs.writeFileSync(path.join(repo, "deleted.txt"), "trunk\n");
    replaceLink(path.join(repo, "link"), "trunk-target");
    runGit(repo, "commit", "-qam", "trunk");
    mergeFeature(repo);

    expect(await listConflictedFiles(repo)).toEqual([path.join(repo, "both.txt")]);
  });
});

function replaceLink(link: string, target: string): void {
  fs.rmSync(link);
  fs.symlinkSync(target, link);
}

describe("markResolved", () => {
  it("stages only the named file, even when its name looks like a pattern", async () => {
    divergeBranches(repo, ["app/[id].tsx", "app/i.tsx", "app/d.tsx"]);
    mergeFeature(repo);

    await markResolved(path.join(repo, "app/[id].tsx"));

    expect([...(await listConflictedFiles(repo))].sort()).toEqual([path.join(repo, "app/d.tsx"), path.join(repo, "app/i.tsx")]);
  });

  it("stages a file opened through a symbolic link to its directory", async () => {
    divergeBranches(repo, ["sub/f.txt", "other.txt"]);
    mergeFeature(repo);
    const links = fs.mkdtempSync(path.join(os.tmpdir(), "jw-differ-links-"));
    try {
      fs.symlinkSync(path.join(repo, "sub"), path.join(links, "sub"));

      await markResolved(path.join(links, "sub", "f.txt"));

      expect(await listConflictedFiles(repo)).toEqual([path.join(repo, "other.txt")]);
    } finally {
      fs.rmSync(links, { recursive: true, force: true });
    }
  });
});
