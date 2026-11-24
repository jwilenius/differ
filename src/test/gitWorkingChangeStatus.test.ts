import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseStatus, readWorkingChangeSummary } from "../git/gitWorkingChangeStatus";
import { WORKING_CHANGE_PATH_LIMIT } from "../model/historyWorkingChanges";
import type { WorkingChangeSummary } from "../model/historyWorkingChanges";
import {
  captureRepositoryState,
  commitFiles,
  createHistoryRepository,
  disposeHistoryRepository,
  fixtureGitEnvironment,
  runFixtureGit,
} from "./gitHistoryFixture";
import type { HistoryRepositoryFixture } from "./gitHistoryFixture";

const signal = new AbortController().signal;
const CLEAN: WorkingChangeSummary = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, isTruncated: false };

describe("readWorkingChangeSummary", () => {
  let fixture: HistoryRepositoryFixture;

  beforeEach(() => {
    fixture = createHistoryRepository();
    commitFiles(fixture.root, {
      message: "A",
      changes: [
        { kind: "write", path: "a.txt", content: "a\n" },
        { kind: "write", path: "b.txt", content: "b\n" },
        { kind: "write", path: "c.txt", content: "c\n" },
      ],
    });
  });

  afterEach(() => {
    disposeHistoryRepository(fixture);
  });

  function git(...args: string[]): string {
    return runFixtureGit(fixture.root, args);
  }

  function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(fixture.root, filePath)), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, filePath), content);
  }

  function summary(root = fixture.root): Promise<WorkingChangeSummary | null> {
    return readWorkingChangeSummary(root, signal, fixtureGitEnvironment());
  }

  it("counts nothing in a clean working tree", async () => {
    expect(await summary()).toEqual(CLEAN);
  });

  it("counts staged, unstaged, deleted and untracked files apart", async () => {
    writeFile("a.txt", "staged\n");
    git("add", "a.txt");
    writeFile("b.txt", "unstaged\n");
    fs.rmSync(path.join(fixture.root, "c.txt"));
    writeFile("new/untracked.txt", "new\n");

    expect(await summary()).toEqual({ staged: 1, unstaged: 3, untracked: 1, conflicted: 0, isTruncated: false });
  });

  it("counts a file changed in the index and again on disk on both sides", async () => {
    writeFile("a.txt", "staged\n");
    git("add", "a.txt");
    writeFile("a.txt", "unstaged\n");

    expect(await summary()).toEqual({ ...CLEAN, staged: 1, unstaged: 1 });
  });

  it("counts a staged rename once", async () => {
    git("mv", "a.txt", "renamed.txt");

    expect(await summary()).toEqual({ ...CLEAN, staged: 1 });
  });

  it("counts an intent-to-add file as unstaged only", async () => {
    writeFile("later.txt", "later\n");
    git("add", "--intent-to-add", "later.txt");

    expect(await summary()).toEqual({ ...CLEAN, unstaged: 1 });
  });

  it("counts conflicted files as unstaged", async () => {
    git("checkout", "-q", "-b", "side");
    commitFiles(fixture.root, { message: "side", changes: [{ kind: "write", path: "a.txt", content: "side\n" }] });
    git("checkout", "-q", "main");
    commitFiles(fixture.root, { message: "main", changes: [{ kind: "write", path: "a.txt", content: "main\n" }] });
    expect(() => git("merge", "-q", "side")).toThrow();

    expect(await summary()).toEqual({ ...CLEAN, unstaged: 1, conflicted: 1 });
  });

  it("leaves out untracked files when status.showUntrackedFiles is no", async () => {
    writeFile("untracked.txt", "new\n");
    git("config", "status.showUntrackedFiles", "no");

    expect(await summary()).toEqual(CLEAN);
  });

  it("leaves out an untracked nested repository", async () => {
    runFixtureGit(fixture.root, ["init", "-q", "--template=", "nested"]);

    expect(await summary()).toEqual(CLEAN);
  });

  it("stops counting at the path limit and says the list is cut off", async () => {
    const directory = path.join(fixture.root, "many");
    fs.mkdirSync(directory);
    for (let index = 0; index <= WORKING_CHANGE_PATH_LIMIT; index += 1) {
      fs.writeFileSync(path.join(directory, `${index}.txt`), "");
    }

    const limit = WORKING_CHANGE_PATH_LIMIT;
    expect(await summary()).toEqual({ ...CLEAN, unstaged: limit, untracked: limit, isTruncated: true });
  });

  it("is null for a bare repository", async () => {
    const bare = path.join(fixture.directory, "bare.git");
    runFixtureGit(fixture.directory, ["clone", "-q", "--bare", fixture.root, bare]);

    expect(await summary(bare)).toBeNull();
  });

  it("leaves the index, refs and files untouched even when the index is stale", async () => {
    writeFile("a.txt", "changed\n");
    // An older modification time makes Git rehash a.txt; a refreshing status would rewrite the index.
    const past = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(fixture.root, "b.txt"), past, past);
    const before = captureRepositoryState(fixture.root);

    await summary();

    expect(captureRepositoryState(fixture.root)).toEqual(before);
    expect(fs.existsSync(path.join(fixture.root, ".git", "index.lock"))).toBe(false);
  });
});

describe("parseStatus", () => {
  function records(...lines: string[]): Buffer {
    return Buffer.from(lines.map((line) => `${line}\0`).join(""), "utf8");
  }

  const OIDS = "100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222";

  it("keeps working-tree paths with spaces and only the new side of a file renamed in the index", () => {
    const status = parseStatus(records(
      `1 .M N... ${OIDS} with space.txt`,
      `2 RM N... ${OIDS} R100 new name.txt`,
      "old name.txt",
      "? untracked file.txt",
    ));

    expect(status.worktreePaths.map(String)).toEqual(["with space.txt", "new name.txt", "untracked file.txt"]);
    expect(status.summary).toEqual({ staged: 1, unstaged: 3, untracked: 1, conflicted: 0, isTruncated: false });
  });

  it("keeps both sides of a file renamed in the working tree", () => {
    const status = parseStatus(records(`2 .R N... ${OIDS} R100 new name.txt`, "old name.txt"));

    expect(status.worktreePaths.map(String)).toEqual(["new name.txt", "old name.txt"]);
    expect(status.summary).toEqual({ ...CLEAN, unstaged: 1 });
  });

  it("ignores content changes inside a submodule but counts a staged gitlink", () => {
    const status = parseStatus(records(`1 MM SCM. ${OIDS} module`));

    expect(status.worktreePaths).toEqual([]);
    expect(status.summary).toEqual({ ...CLEAN, staged: 1 });
  });
});
