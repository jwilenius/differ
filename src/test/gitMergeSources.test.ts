import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type MergeSources, readMergeSources, type UnmergeableConflict } from "../git/gitMergeSources";
import {
  createConflictRepository,
  divergeBranches,
  divergeFile,
  type FileVersions,
  mergeFeature,
  runGit,
} from "./gitConflictFixture";

let repo: string;
let file: string;

const git = (...args: string[]): void => {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
};

/** Builds a real repository whose merge leaves f.txt conflicted. */
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "differ-git-"));
  file = path.join(repo, "f.txt");

  execFileSync("git", ["init", "-q", "-b", "trunk", repo], { stdio: "pipe" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  fs.writeFileSync(file, "line1\nshared\nline3\n");
  git("add", "f.txt");
  git("commit", "-qm", "base");

  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(file, "line1\nMINE\nline3\nextra-mine\n");
  git("commit", "-qam", "mine");

  git("checkout", "-q", "trunk");
  fs.writeFileSync(file, "line1\nTHEIRS\nline3\n");
  git("commit", "-qam", "theirs");

  git("checkout", "-q", "feature");
  try {
    git("merge", "trunk");
  } catch {
    // The merge is expected to conflict.
  }
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The sources read, failing the test when the conflict was found unmergeable. */
function mergeable(sources: MergeSources | UnmergeableConflict): MergeSources {
  if ("unmergeable" in sources) {
    throw new Error(`The conflict is unmergeable: ${sources.unmergeable}.`);
  }
  return sources;
}

describe("readMergeSources", () => {
  it("reads the branch version from the ours stage", async () => {
    const sources = mergeable(await readMergeSources(file));

    expect(sources.ours).toBe("line1\nMINE\nline3\nextra-mine\n");
  });

  it("reads the incoming version from the theirs stage", async () => {
    const sources = mergeable(await readMergeSources(file));

    expect(sources.theirs).toBe("line1\nTHEIRS\nline3\n");
  });

  it("reads the common ancestor from the base stage", async () => {
    const sources = mergeable(await readMergeSources(file));

    expect(sources.base).toBe("line1\nshared\nline3\n");
  });

  it("labels the panes with the two branch names", async () => {
    const sources = mergeable(await readMergeSources(file));

    expect(sources.ourLabel).toBe("feature");
    expect(sources.theirLabel).toBe("trunk");
  });

  it("reports a merge as not having the sides swapped", async () => {
    const sources = mergeable(await readMergeSources(file));

    expect(sources.isSidesSwapped).toBe(false);
  });

  it("reads the repository Git finds from the file, ignoring an inherited GIT_DIR", async () => {
    vi.stubEnv("GIT_DIR", path.join(repo, "no-such-git-dir"));

    const sources = mergeable(await readMergeSources(file));

    expect(sources.ours).toBe("line1\nMINE\nline3\nextra-mine\n");
  });

  it("reports no mergeable conflict for a file with no conflict stages", async () => {
    const clean = path.join(repo, "clean.txt");
    fs.writeFileSync(clean, "nothing to merge\n");

    expect(await readMergeSources(clean)).toEqual({ unmergeable: "noMergeableConflict" });
  });

  it("reports no mergeable conflict outside a git repository", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "differ-nogit-"));
    const orphan = path.join(outside, "f.txt");
    fs.writeFileSync(orphan, "text");

    expect(await readMergeSources(orphan)).toEqual({ unmergeable: "noMergeableConflict" });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("reports missing Git as an error instead of a file with no conflict", async () => {
    vi.stubEnv("PATH", repo);

    const reading = readMergeSources(file);

    await expect(reading).rejects.toMatchObject({ name: "HistoryGitError", kind: "missingGit" });
  });

  it("reports a repository Git refuses as unsafe as an error instead of a file with no conflict", async () => {
    vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");

    const reading = readMergeSources(file);

    await expect(reading).rejects.toMatchObject({ name: "HistoryGitError", exitCode: 128, message: /dubious ownership/ });
  });

  it("reports no mergeable conflict in the git directory, which has no work tree", async () => {
    const gitFile = path.join(repo, ".git", "HEAD");

    expect(await readMergeSources(gitFile)).toEqual({ unmergeable: "noMergeableConflict" });
  });
});

describe("readMergeSources with a corrupt index", () => {
  let corruptRepo: string;

  beforeAll(() => {
    corruptRepo = createConflictRepository();
    divergeBranches(corruptRepo, ["f.txt"]);
    mergeFeature(corruptRepo);
    fs.writeFileSync(path.join(corruptRepo, ".git", "index"), "not an index");
  });

  afterAll(() => {
    fs.rmSync(corruptRepo, { recursive: true, force: true });
  });

  it("reports the unreadable index as an error instead of a file with no conflict", async () => {
    const reading = readMergeSources(path.join(corruptRepo, "f.txt"));

    await expect(reading).rejects.toMatchObject({ name: "HistoryGitError", kind: "failed", exitCode: 128 });
  });
});

describe("readMergeSources with an emptied side", () => {
  let emptiedRepo: string;

  beforeAll(() => {
    emptiedRepo = createConflictRepository();
    const emptied = path.join(emptiedRepo, "f.txt");
    fs.writeFileSync(emptied, "base\n");
    runGit(emptiedRepo, "add", "f.txt");
    runGit(emptiedRepo, "commit", "-qm", "base");
    runGit(emptiedRepo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(emptied, "");
    runGit(emptiedRepo, "commit", "-qam", "empty");
    runGit(emptiedRepo, "checkout", "-q", "trunk");
    fs.writeFileSync(emptied, "trunk\n");
    runGit(emptiedRepo, "commit", "-qam", "trunk");
    mergeFeature(emptiedRepo);
  });

  afterAll(() => {
    fs.rmSync(emptiedRepo, { recursive: true, force: true });
  });

  it("reads a side whose version is empty as empty text, not as missing", async () => {
    const emptied = path.join(emptiedRepo, "f.txt");

    const sources = mergeable(await readMergeSources(emptied));

    expect(sources.ours).toBe("trunk\n");
    expect(sources.theirs).toBe("");
  });
});

describe("readMergeSources with a symbolic link conflict", () => {
  let linkRepo: string;

  beforeAll(() => {
    linkRepo = createConflictRepository();
    const link = path.join(linkRepo, "link");
    fs.symlinkSync("base-target", link);
    runGit(linkRepo, "add", "link");
    runGit(linkRepo, "commit", "-qm", "base");
    runGit(linkRepo, "checkout", "-q", "-b", "feature");
    fs.rmSync(link);
    fs.symlinkSync("feature-target", link);
    runGit(linkRepo, "commit", "-qam", "feature");
    runGit(linkRepo, "checkout", "-q", "trunk");
    fs.rmSync(link);
    fs.symlinkSync("trunk-target", link);
    runGit(linkRepo, "commit", "-qam", "trunk");
    mergeFeature(linkRepo);
  });

  afterAll(() => {
    fs.rmSync(linkRepo, { recursive: true, force: true });
  });

  it("reports no mergeable conflict, because saving a merge result would write through the link", async () => {
    expect(await readMergeSources(path.join(linkRepo, "link"))).toEqual({ unmergeable: "noMergeableConflict" });
  });
});

describe("readMergeSources through a symbolic link to a directory", () => {
  let linkedRepo: string;
  let links: string;

  /** Opens `sub/f.txt` both through a link to the whole checkout and through a link to its own directory. */
  beforeAll(() => {
    linkedRepo = createConflictRepository();
    divergeBranches(linkedRepo, ["sub/f.txt"]);
    mergeFeature(linkedRepo);
    links = fs.mkdtempSync(path.join(os.tmpdir(), "differ-links-"));
    fs.symlinkSync(linkedRepo, path.join(links, "checkout"));
    fs.symlinkSync(path.join(linkedRepo, "sub"), path.join(links, "sub"));
  });

  afterAll(() => {
    fs.rmSync(links, { recursive: true, force: true });
    fs.rmSync(linkedRepo, { recursive: true, force: true });
  });

  it.each([
    ["the checkout", "checkout/sub/f.txt"],
    ["the file's own directory", "sub/f.txt"],
  ])("reads the conflict of a file opened through a link to %s", async (_linked, linkedPath) => {
    const sources = mergeable(await readMergeSources(path.join(links, linkedPath)));

    expect(sources).toMatchObject({ base: "base\n", ours: "trunk\n", theirs: "feature\n", ourLabel: "trunk" });
  });

  it("does not follow a symbolic link to the conflicted file, which is not itself in conflict", async () => {
    const alias = path.join(linkedRepo, "alias.txt");
    fs.symlinkSync(path.join(linkedRepo, "sub", "f.txt"), alias);

    expect(await readMergeSources(alias)).toEqual({ unmergeable: "noMergeableConflict" });
  });
});

describe("readMergeSources with versions that are not UTF-8 text", () => {
  let encodedRepo: string;

  /** Reads the conflict the merge leaves when `f.txt` diverges as `versions`. */
  async function readConflictOver(versions: FileVersions): Promise<MergeSources | UnmergeableConflict> {
    encodedRepo = createConflictRepository();
    divergeFile(encodedRepo, "f.txt", versions);
    mergeFeature(encodedRepo);
    const conflicted = path.join(encodedRepo, "f.txt");
    return readMergeSources(conflicted);
  }

  afterEach(() => {
    fs.rmSync(encodedRepo, { recursive: true, force: true });
  });

  it("reports a Latin-1 file as not UTF-8 instead of merging it with its characters replaced", async () => {
    const latin1 = (text: string): Buffer => Buffer.from(text, "latin1");

    const sources = await readConflictOver({
      base: latin1("caf\u00e9\nshared\n"),
      feature: latin1("caf\u00e9\nmine\n"),
      trunk: latin1("caf\u00e9\ntheirs\n"),
    });

    expect(sources).toEqual({ unmergeable: "invalidEncoding" });
  });

  it("reports a file one side made binary, holding a NUL byte, as binary", async () => {
    const sources = await readConflictOver({ base: "text\n", feature: "bin\0ary\n", trunk: "trunk\n" });

    expect(sources).toEqual({ unmergeable: "binary" });
  });

  it("leaves out a UTF-8 byte order mark, which the file's own encoding keeps", async () => {
    const sources = await readConflictOver({
      base: "\ufeffline1\nshared\n",
      feature: "\ufeffline1\nmine\n",
      trunk: "\ufeffline1\ntheirs\n",
    });

    expect(sources).toMatchObject({
      base: "line1\nshared\n",
      ours: "line1\ntheirs\n",
      theirs: "line1\nmine\n",
      hasByteOrderMark: true,
    });
  });

  it("gives the result the byte order mark a side added, as git merges a change one side made", async () => {
    const sources = await readConflictOver({ base: "line1\nshared\n", feature: "\ufeffline1\nmine\n", trunk: "line1\ntheirs\n" });

    expect(sources).toMatchObject({ theirs: "line1\nmine\n", hasByteOrderMark: true });
  });

  it("leaves out of the result the byte order mark a side removed", async () => {
    const sources = await readConflictOver({
      base: "\ufeffline1\nshared\n",
      feature: "\ufeffline1\nmine\n",
      trunk: "line1\ntheirs\n",
    });

    expect(sources).toMatchObject({ ours: "line1\ntheirs\n", hasByteOrderMark: false });
  });

  it("gives no byte order mark to a result whose versions have none", async () => {
    const sources = await readConflictOver({ base: "line1\nshared\n", feature: "line1\nmine\n", trunk: "line1\ntheirs\n" });

    expect(sources).toMatchObject({ hasByteOrderMark: false });
  });
});

describe("readMergeSources sides by the operation that left the conflict", () => {
  let operationRepo: string;

  /** Reads `f.txt` once `conflict` leaves it conflicted, starting on `trunk` with `f.txt` diverged from `feature`. */
  async function readConflictAfter(conflict: (root: string) => void): Promise<MergeSources> {
    operationRepo = createConflictRepository();
    divergeBranches(operationRepo, ["f.txt"]);
    conflict(operationRepo);
    const conflicted = path.join(operationRepo, "f.txt");
    return mergeable(await readMergeSources(conflicted));
  }

  /** Runs a Git command that is expected to stop on a conflict. */
  function runConflicting(root: string, ...args: string[]): void {
    try {
      runGit(root, ...args);
    } catch {
      // The command is expected to conflict.
    }
  }

  afterEach(() => {
    fs.rmSync(operationRepo, { recursive: true, force: true });
  });

  it.each(["--merge", "--apply"])("reports a rebase with the %s backend as having the sides swapped", async (backend) => {
    const sources = await readConflictAfter((root) => {
      runGit(root, "checkout", "-q", "feature");
      runConflicting(root, "rebase", backend, "trunk");
    });

    expect(sources).toMatchObject({ ours: "trunk\n", theirs: "feature\n", isSidesSwapped: true });
  });

  it("reports a rebase in a linked worktree, whose state is outside its own directory, as having the sides swapped", async () => {
    operationRepo = createConflictRepository();
    divergeBranches(operationRepo, ["f.txt"]);
    const worktree = path.join(operationRepo, ".git", "linked");
    runGit(operationRepo, "worktree", "add", "-q", worktree, "feature");
    runConflicting(worktree, "rebase", "trunk");
    const conflicted = path.join(worktree, "f.txt");

    const sources = mergeable(await readMergeSources(conflicted));

    expect(sources).toMatchObject({ ours: "trunk\n", theirs: "feature\n", isSidesSwapped: true });
  });

  it("reports a cherry-pick, which keeps your branch as ours, as not having the sides swapped", async () => {
    const sources = await readConflictAfter((root) => runConflicting(root, "cherry-pick", "feature"));

    expect(sources).toMatchObject({ ours: "trunk\n", theirs: "feature\n", ourLabel: "trunk", isSidesSwapped: false });
  });

  it("reports a revert as not having the sides swapped", async () => {
    const sources = await readConflictAfter((root) => {
      fs.writeFileSync(path.join(root, "f.txt"), "later\n");
      runGit(root, "commit", "-qam", "later");
      runConflicting(root, "revert", "--no-edit", "HEAD~1");
    });

    expect(sources).toMatchObject({ ours: "later\n", theirs: "base\n", isSidesSwapped: false });
  });

  it("reports a popped stash with neutral labels and the sides not swapped", async () => {
    const sources = await readConflictAfter((root) => {
      fs.writeFileSync(path.join(root, "f.txt"), "stashed\n");
      runGit(root, "stash", "-q");
      fs.writeFileSync(path.join(root, "f.txt"), "committed\n");
      runGit(root, "commit", "-qam", "committed");
      runConflicting(root, "stash", "pop", "-q");
    });

    expect(sources).toMatchObject({
      ours: "committed\n",
      theirs: "stashed\n",
      ourLabel: "trunk",
      theirLabel: "Incoming",
      isSidesSwapped: false,
    });
  });

  it("reports a three-way patch application as not having the sides swapped", async () => {
    const sources = await readConflictAfter((root) => {
      const patch = path.join(root, ".git", "feature.patch");
      fs.writeFileSync(patch, execFileSync("git", ["diff", "trunk~1", "feature", "--", "f.txt"], { cwd: root }));
      runConflicting(root, "apply", "-3", patch);
    });

    expect(sources).toMatchObject({ ours: "trunk\n", theirs: "feature\n", isSidesSwapped: false });
  });
});
