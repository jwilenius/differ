import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPARISON_FILE_LIMIT_BYTES } from "../git/gitComparisonFiles";
import { type ChangeReadResult, readStagedChange, readWorkingTreeChange } from "../git/gitWorkingChanges";
import { createConflictRepository, divergeBranches, mergeFeature, runGit } from "./gitConflictFixture";

let root: string;

beforeEach(() => {
  root = createConflictRepository();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer): string {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Commits `content` as `name` and returns the file's path. */
function commit(name: string, content: string): string {
  const file = write(name, content);
  runGit(root, "add", "--", name);
  runGit(root, "commit", "-qm", `commit ${name}`);
  return file;
}

/** Commits a repository nested at `nested` as a submodule entry (gitlink) and returns its path. */
function commitNestedRepository(): string {
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  runGit(nested, "init", "-q", "-b", "trunk");
  fs.writeFileSync(path.join(nested, "g.txt"), "inner\n");
  runGit(nested, "add", ".");
  runGit(nested, "commit", "-qm", "nested");
  runGit(root, "add", "nested");
  return nested;
}

/** The comparison's labels, paths and texts in one object, so each case asserts the whole comparison. */
function summarize(result: ChangeReadResult): unknown {
  if ("unreadable" in result) {
    return result;
  }
  return {
    base: [result.base.label, result.base.path, result.base.text],
    result: [result.result.label, result.result.path, result.result.text],
    hasResultFile: result.hasResultFile,
  };
}

describe("readWorkingTreeChange", () => {
  it("compares the index with an unstaged modification", async () => {
    const file = commit("f.txt", "one\n");
    fs.writeFileSync(file, "two\n");

    expect(summarize(await readWorkingTreeChange(file))).toEqual({
      base: ["Index", "f.txt", "one\n"],
      result: ["Working Tree", "f.txt", "two\n"],
      hasResultFile: true,
    });
  });

  it("compares against the staged version when the file is also staged", async () => {
    const file = commit("f.txt", "one\n");
    fs.writeFileSync(file, "two\n");
    runGit(root, "add", "f.txt");
    fs.writeFileSync(file, "three\n");

    expect(summarize(await readWorkingTreeChange(file))).toMatchObject({
      base: ["Index", "f.txt", "two\n"],
      result: ["Working Tree", "f.txt", "three\n"],
    });
  });

  it("compares an untracked file with nothing", async () => {
    commit("f.txt", "one\n");
    const file = write("new.txt", "fresh\n");

    expect(summarize(await readWorkingTreeChange(file))).toEqual({
      base: ["Index", "", ""],
      result: ["Working Tree", "new.txt", "fresh\n"],
      hasResultFile: true,
    });
  });

  it("compares an untracked file in a repository without commits", async () => {
    const file = write("new.txt", "fresh\n");

    expect(summarize(await readWorkingTreeChange(file))).toMatchObject({ base: ["Index", "", ""] });
  });

  it("compares an intent-to-add file with its empty index entry", async () => {
    commit("f.txt", "one\n");
    const file = write("new.txt", "fresh\n");
    runGit(root, "add", "--intent-to-add", "new.txt");

    expect(summarize(await readWorkingTreeChange(file))).toMatchObject({
      base: ["Index", "new.txt", ""],
      result: ["Working Tree", "new.txt", "fresh\n"],
    });
  });

  it("compares a deleted file with nothing", async () => {
    const file = commit("f.txt", "one\n");
    fs.rmSync(file);

    expect(summarize(await readWorkingTreeChange(file))).toEqual({
      base: ["Index", "f.txt", "one\n"],
      result: ["Working Tree", "", ""],
      hasResultFile: false,
    });
  });

  it("finds a file in a subfolder whose directory was deleted", async () => {
    const file = commit("src/deep/f.txt", "one\n");
    fs.rmSync(path.join(root, "src", "deep"), { recursive: true });

    expect(summarize(await readWorkingTreeChange(file))).toMatchObject({
      base: ["Index", "src/deep/f.txt", "one\n"],
      result: ["Working Tree", "", ""],
    });
  });

  it("reads a nested repository's file relative to that repository", async () => {
    commit("f.txt", "outer\n");
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    runGit(nested, "init", "-q", "-b", "trunk");
    fs.mkdirSync(path.join(nested, "lib"));
    const file = path.join(nested, "lib", "g.txt");
    fs.writeFileSync(file, "inner\n");
    runGit(nested, "add", ".");
    runGit(nested, "commit", "-qm", "nested");
    fs.writeFileSync(file, "changed\n");

    expect(summarize(await readWorkingTreeChange(file))).toMatchObject({
      base: ["Index", "lib/g.txt", "inner\n"],
      result: ["Working Tree", "lib/g.txt", "changed\n"],
    });
  });

  it("treats the file name literally rather than as a pattern", async () => {
    commit("fz.txt", "other\n");
    const file = commit("f*.txt", "star\n");
    fs.writeFileSync(file, "changed\n");

    expect(summarize(await readWorkingTreeChange(file))).toMatchObject({ base: ["Index", "f*.txt", "star\n"] });
  });

  it("uses the editor's unsaved text instead of the file on disk", async () => {
    const file = commit("f.txt", "one\n");

    expect(summarize(await readWorkingTreeChange(file, "unsaved\n"))).toMatchObject({
      result: ["Working Tree", "f.txt", "unsaved\n"],
    });
  });

  it("compares a symbolic link's targets", async () => {
    fs.symlinkSync("first.txt", path.join(root, "link"));
    runGit(root, "add", "link");
    runGit(root, "commit", "-qm", "link");
    fs.rmSync(path.join(root, "link"));
    fs.symlinkSync("second.txt", path.join(root, "link"));

    expect(summarize(await readWorkingTreeChange(path.join(root, "link")))).toMatchObject({
      base: ["Index", "link", "first.txt"],
      result: ["Working Tree", "link", "second.txt"],
    });
  });

  it("compares a conflicted file with HEAD, as the index holds only its conflict stages", async () => {
    divergeBranches(root, ["f.txt"]);
    mergeFeature(root);

    const result = await readWorkingTreeChange(path.join(root, "f.txt"));

    expect(summarize(result)).toMatchObject({ base: ["HEAD", "f.txt", "trunk\n"] });
  });

  it("compares a conflicted file HEAD lacks with nothing", async () => {
    commit("f.txt", "base\n");
    runGit(root, "checkout", "-qb", "feature");
    commit("f.txt", "feature\n");
    runGit(root, "checkout", "-q", "trunk");
    runGit(root, "rm", "-q", "f.txt");
    runGit(root, "commit", "-qm", "delete f.txt");
    mergeFeature(root);

    expect(summarize(await readWorkingTreeChange(path.join(root, "f.txt")))).toEqual({
      base: ["HEAD", "", ""],
      result: ["Working Tree", "f.txt", "feature\n"],
      hasResultFile: true,
    });
  });

  it("compares a CRLF working tree with its LF index version line by line", async () => {
    write(".gitattributes", "*.txt text eol=crlf\n");
    const file = commit("f.txt", "one\r\ntwo\r\n");
    fs.writeFileSync(file, "one\r\nTWO\r\n");

    expect(summarize(await readWorkingTreeChange(file))).toMatchObject({
      base: ["Index", "f.txt", "one\ntwo\n"],
      result: ["Working Tree", "f.txt", "one\nTWO\n"],
    });
  });

  it("reports a submodule as not a file", async () => {
    const nested = commitNestedRepository();

    expect(await readWorkingTreeChange(nested)).toEqual({ unreadable: "notAFile" });
  });

  it("reports a file over the comparison limit as unreadable", async () => {
    const file = write("big.txt", Buffer.alloc(COMPARISON_FILE_LIMIT_BYTES + 1, "a"));

    expect(await readWorkingTreeChange(file)).toEqual({ unreadable: "oversize" });
  });

  it("reports a binary file as unreadable", async () => {
    const file = commit("f.bin", "text\n");
    fs.writeFileSync(file, Buffer.from([0x61, 0x00, 0x62]));

    expect(await readWorkingTreeChange(file)).toEqual({ unreadable: "binary" });
  });

  it("reports a file that is not UTF-8 as unreadable", async () => {
    const file = commit("f.txt", "text\n");
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x41]));

    expect(await readWorkingTreeChange(file)).toEqual({ unreadable: "invalidEncoding" });
  });

  it("reports a directory, as an untracked nested repository's, as not a file", async () => {
    commit("f.txt", "one\n");
    fs.mkdirSync(path.join(root, "folder"));

    expect(await readWorkingTreeChange(path.join(root, "folder"))).toEqual({ unreadable: "notAFile" });
  });
});

describe("readStagedChange", () => {
  it("compares HEAD with a staged modification", async () => {
    const file = commit("f.txt", "one\n");
    fs.writeFileSync(file, "two\n");
    runGit(root, "add", "f.txt");
    fs.writeFileSync(file, "three\n");

    expect(summarize(await readStagedChange(file))).toEqual({
      base: ["HEAD", "f.txt", "one\n"],
      result: ["Index", "f.txt", "two\n"],
      hasResultFile: true,
    });
  });

  it("compares a staged new file with nothing", async () => {
    commit("f.txt", "one\n");
    const file = write("new.txt", "fresh\n");
    runGit(root, "add", "new.txt");

    expect(summarize(await readStagedChange(file))).toMatchObject({
      base: ["HEAD", "", ""],
      result: ["Index", "new.txt", "fresh\n"],
    });
  });

  it("compares a file staged before the first commit with nothing", async () => {
    const file = write("new.txt", "fresh\n");
    runGit(root, "add", "new.txt");

    expect(summarize(await readStagedChange(file))).toMatchObject({
      base: ["HEAD", "", ""],
      result: ["Index", "new.txt", "fresh\n"],
    });
  });

  it("compares a staged deletion with nothing", async () => {
    const file = commit("f.txt", "one\n");
    runGit(root, "rm", "-q", "f.txt");

    expect(summarize(await readStagedChange(file))).toEqual({
      base: ["HEAD", "f.txt", "one\n"],
      result: ["Index", "", ""],
      hasResultFile: false,
    });
  });

  it("compares a staged rename with the old path's version", async () => {
    commit("src/old.txt", "kept\nlines\nhere\n");
    runGit(root, "mv", "src/old.txt", "moved.txt");
    const file = path.join(root, "moved.txt");
    fs.appendFileSync(file, "more\n");
    runGit(root, "add", "moved.txt");

    expect(summarize(await readStagedChange(file))).toMatchObject({
      base: ["HEAD", "src/old.txt", "kept\nlines\nhere\n"],
      result: ["Index", "moved.txt", "kept\nlines\nhere\nmore\n"],
    });
  });

  it("reads a staged file in a subfolder from that folder", async () => {
    const file = commit("src/f.txt", "one\n");
    fs.writeFileSync(file, "two\n");
    runGit(root, "add", "src/f.txt");

    expect(summarize(await readStagedChange(file))).toMatchObject({
      base: ["HEAD", "src/f.txt", "one\n"],
      result: ["Index", "src/f.txt", "two\n"],
    });
  });

  it("reports a staged submodule as not a file", async () => {
    commit("f.txt", "one\n");
    const nested = commitNestedRepository();

    expect(await readStagedChange(nested)).toEqual({ unreadable: "notAFile" });
  });

  it("reports a staged file over the comparison limit as unreadable", async () => {
    commit("f.txt", "one\n");
    write("big.txt", Buffer.alloc(COMPARISON_FILE_LIMIT_BYTES + 1, "a"));
    runGit(root, "add", "big.txt");

    expect(await readStagedChange(path.join(root, "big.txt"))).toEqual({ unreadable: "oversize" });
  });

  it("reports a staged binary file as unreadable", async () => {
    const file = commit("f.bin", "text\n");
    fs.writeFileSync(file, Buffer.from([0x61, 0x00, 0x62]));
    runGit(root, "add", "f.bin");

    expect(await readStagedChange(file)).toEqual({ unreadable: "binary" });
  });
});
