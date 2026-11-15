import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

type Bump = "none" | "patch" | "minor" | "major";

/** The exports of `scripts/next-release-version.mjs`; a plain script, so its types are declared here. */
interface NextReleaseVersionScript {
  commitBump(message: string): Bump;
  releaseBump(messages: readonly string[]): Bump;
  bumpVersion(version: string, bump: Bump): string;
}

const SCRIPT = resolve("scripts/next-release-version.mjs");

let script: NextReleaseVersionScript;

beforeAll(async () => {
  script = (await import(pathToFileURL(SCRIPT).href)) as NextReleaseVersionScript;
});

describe("commit bump", () => {
  it.each<[string, Bump]>([
    ["feat: add history search", "minor"],
    ["fix: keep the caret on undo", "patch"],
    ["feat(history): add search", "minor"],
    ["fix(merge view): keep the caret", "patch"],
    ["Feat: upper-case type", "minor"],
    ["FIX: upper-case type", "patch"],
    ["feat!: drop VS Code 1.89", "major"],
    ["fix(merge)!: rename the setting", "major"],
    ["docs!: remove the install guide", "major"],
    ["chore(deps)!: require Node.js 22", "major"],
  ])("reads %j as %s", (message, bump) => {
    expect(script.commitBump(message)).toBe(bump);
  });

  it.each(["docs", "test", "chore", "style", "refactor", "perf", "ci", "build", "revert"])(
    "never releases a %s commit",
    (type) => {
      expect(script.commitBump(`${type}: change something`)).toBe("none");
      expect(script.commitBump(`${type}(scope): change something`)).toBe("none");
    },
  );

  it.each([
    "Add history search",
    "feat:missing space",
    "feat add search",
    "feat : space before the colon",
    " feat: leading space",
    "feat(unclosed: scope",
    "feat: ",
    "Merge branch 'topic'",
    'Revert "feat: add history search"',
    "constructor: inherited object property",
    "",
  ])("never releases the non-conforming message %j", (message) => {
    expect(script.commitBump(message)).toBe("none");
  });

  it.each(["BREAKING CHANGE: settings renamed", "BREAKING-CHANGE: settings renamed"])(
    "reads the footer %j as a major bump on any type",
    (footer) => {
      expect(script.commitBump(`fix: rename settings\n\nWhy it changed.\n\n${footer}`)).toBe("major");
      expect(script.commitBump(`docs: rename settings\n\n${footer}`)).toBe("major");
      expect(script.commitBump(`refactor(history): rename\r\n\r\n${footer}\r\n`)).toBe("major");
    },
  );

  it("ignores breaking-change text that is not an upper-case footer line", () => {
    expect(script.commitBump("fix: mention BREAKING CHANGE: in the header")).toBe("patch");
    expect(script.commitBump("fix: lower case\n\nbreaking change: not a footer")).toBe("patch");
    expect(script.commitBump("fix: indented\n\n  BREAKING CHANGE: not a footer")).toBe("patch");
    expect(script.commitBump("Rename settings\n\nBREAKING CHANGE: the header does not conform")).toBe("none");
  });

  it("reads the type from the first line only, whatever the body lists", () => {
    const squashed = "docs: describe the release flow\n\n* feat: add history search\n* fix: keep the caret\n";

    expect(script.commitBump(squashed)).toBe("none");
    expect(script.commitBump("feat: add search\n\nA longer body\nover several lines.\n\nRefs: #12")).toBe("minor");
  });
});

describe("release bump", () => {
  it("takes the highest bump any message asks for", () => {
    expect(script.releaseBump(["docs: a", "fix: b", "test: c"])).toBe("patch");
    expect(script.releaseBump(["fix: a", "feat: b", "fix: c"])).toBe("minor");
    expect(script.releaseBump(["feat: a", "fix!: b", "feat: c"])).toBe("major");
    expect(script.releaseBump(["fix: a\n\nBREAKING CHANGE: b", "feat: c"])).toBe("major");
  });

  it("asks for no release when nothing is releasable or there are no commits", () => {
    expect(script.releaseBump(["docs: a", "test: b", "chore: release v0.3.0", "Merge branch 'x'"])).toBe("none");
    expect(script.releaseBump([])).toBe("none");
  });
});

describe("version bump", () => {
  it.each<[string, Bump, string]>([
    ["0.3.0", "patch", "0.3.1"],
    ["0.3.0", "minor", "0.4.0"],
    ["0.3.0", "major", "1.0.0"],
    ["1.2.3", "minor", "1.3.0"],
    ["1.2.3", "major", "2.0.0"],
    ["9.19.99", "patch", "9.19.100"],
    ["1.2.3", "none", ""],
  ])("raises %s by a %s bump to %j", (version, bump, next) => {
    expect(script.bumpVersion(version, bump)).toBe(next);
  });

  it.each(["1.0", "1.0.0-beta.1", "v1.0.0", "01.2.3", ""])("rejects the version %j", (version) => {
    expect(() => script.bumpVersion(version, "patch")).toThrow("is not plain X.Y.Z");
    expect(() => script.bumpVersion(version, "none")).toThrow("is not plain X.Y.Z");
  });
});

describe("next release version command", () => {
  let repo: string;

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  }

  function commit(message: string): void {
    git("commit", "-q", "--allow-empty", "-m", message);
  }

  function writePackageVersion(version: string): void {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", version }));
  }

  function run(): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
    return spawnSync(process.execPath, [SCRIPT, repo], { encoding: "utf8" });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "differ-next-release-"));
    git("init", "-q");
    writePackageVersion("0.3.0");
    git("add", ".");
    commit("chore: release v0.3.0");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("prints the next version from the commits since the last release tag", () => {
    git("tag", "-a", "v0.3.0", "-m", "Release v0.3.0");
    commit("fix: keep the caret");
    commit("feat: add history search");
    commit("docs: describe search");

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("0.4.0\n");
    expect(result.stderr).toContain("Next release v0.4.0: minor bump over v0.3.0 from 3 commits.");
  });

  it("prints nothing when no commit since the tag asks for a release", () => {
    commit("feat: released before the tag");
    git("tag", "v0.3.0");
    commit("docs: describe search");
    commit("test: cover search");
    commit("chore: update tooling");

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No release: none of the 3 commits since v0.3.0");
  });

  it("prints nothing when HEAD is the release commit", () => {
    git("tag", "-a", "v0.3.0", "-m", "Release v0.3.0");

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("bumps the package.json version and scans every commit when no release tag exists", () => {
    commit("fix: keep the caret");
    git("tag", "v1.0.0-rc.1");
    git("tag", "vnext");

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("0.3.1\n");
    expect(result.stderr).toContain("patch bump over package.json version 0.3.0 (no release tag) from 2 commits.");
  });

  it("counts from the numerically highest release tag reachable from HEAD", () => {
    git("tag", "v0.1.0");
    commit("feat: released in 0.9.0");
    git("tag", "v0.9.0");
    writePackageVersion("0.10.0");
    git("commit", "-qam", "feat: released in 0.10.0");
    git("tag", "-a", "v0.10.0", "-m", "Release v0.10.0");
    git("checkout", "-q", "-b", "unreleased");
    commit("feat: on another branch");
    git("tag", "v5.0.0");
    git("checkout", "-q", "-");
    commit("fix: keep the caret");

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("0.10.1\n");
  });

  it("includes the commits a merge brought in", () => {
    git("tag", "v0.3.0");
    git("checkout", "-q", "-b", "topic");
    commit("feat: add history search");
    git("checkout", "-q", "-");
    commit("docs: describe search");
    git("merge", "-q", "--no-ff", "-m", "Merge branch 'topic'", "topic");

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("0.4.0\n");
    expect(result.stderr).toContain("from 3 commits");
  });

  it("fails without printing a version when the package.json version is not plain X.Y.Z", () => {
    writePackageVersion("1.0.0-beta.1");
    git("commit", "-qam", "fix: keep the caret");

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Version "1.0.0-beta.1" is not plain X.Y.Z.');
  });

  it.each(["0.4.0", "0.2.0"])("fails when package.json holds %s instead of the last release tag's version", (version) => {
    git("tag", "v0.3.0");
    writePackageVersion(version);
    git("commit", "-qam", "feat: add history search");

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`package.json version ${version} differs from the last release tag v0.3.0.`);
  });
});
