import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Author and committer date used when a commit does not specify one, so object IDs are reproducible. */
export const FIXTURE_DEFAULT_DATE = "2026-01-01T00:00:00Z";

export interface HistoryRepositoryFixture {
  /** Temporary directory owning the repository and any sibling worktrees created by a test. */
  readonly directory: string;
  /** Working tree root of the main repository. */
  readonly root: string;
}

export interface FixtureGitOptions {
  /** Exact bytes or text written to stdin. */
  readonly input?: Uint8Array | string;
  /** Extra variables layered over the fixture's isolated environment. */
  readonly env?: Readonly<Record<string, string>>;
}

export type FixtureFileChange =
  | {
    readonly kind: "write";
    readonly path: string;
    readonly content: Uint8Array | string;
    /** Sets or clears the executable bit in the index; leaves the mode unchanged when absent. */
    readonly isExecutable?: boolean;
  }
  | { readonly kind: "delete"; readonly path: string };

export interface FixtureCommit {
  readonly message: string;
  readonly changes: readonly FixtureFileChange[];
  /** ISO author/committer date; defaults to `FIXTURE_DEFAULT_DATE`. */
  readonly date?: string;
  readonly isEmptyAllowed?: boolean;
}

/** Byte-level snapshot of everything a read-only operation must leave untouched. */
export interface RepositoryState {
  readonly head: string;
  readonly refs: string;
  readonly index: Buffer | null;
  /** Working-tree path → file bytes (symlinks → target bytes), tracked and untracked, excluding `.git`. */
  readonly files: ReadonlyMap<string, Buffer>;
}

/** Creates a repository on branch `main` with a test identity, no signing, no hooks and no user configuration. */
export function createHistoryRepository(): HistoryRepositoryFixture {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "differ-history-")));
  const root = path.join(directory, "repo");

  fs.mkdirSync(root);
  runFixtureGit(root, ["init", "-q", "--template=", "-b", "main"]);
  runFixtureGit(root, ["config", "user.name", "Test Author"]);
  runFixtureGit(root, ["config", "user.email", "test@example.com"]);
  runFixtureGit(root, ["config", "commit.gpgSign", "false"]);
  runFixtureGit(root, ["config", "tag.gpgSign", "false"]);
  runFixtureGit(root, ["config", "core.hooksPath", path.join(directory, "no-hooks")]);
  runFixtureGit(root, ["config", "core.autocrlf", "false"]);

  return { directory, root };
}

/**
 * Runs Git in `cwd` without global/system configuration and with deterministic dates. Returns stdout exactly as
 * written; throws when Git exits nonzero.
 */
export function runFixtureGit(cwd: string, args: readonly string[], options: FixtureGitOptions = {}): string {
  return execFileSync("git", [...args], {
    cwd,
    input: options.input,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...fixtureGitEnvironment(), ...options.env },
  });
}

/** Applies the changes, commits them (with `--allow-empty` when requested) and returns the new full commit OID. */
export function commitFiles(root: string, commit: FixtureCommit): string {
  for (const change of commit.changes) {
    applyChange(root, change);
  }

  const date = commit.date ?? FIXTURE_DEFAULT_DATE;
  const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const emptyFlag = commit.isEmptyAllowed === true ? ["--allow-empty"] : [];
  runFixtureGit(root, ["commit", "-q", ...emptyFlag, "-m", commit.message], { env });

  return runFixtureGit(root, ["rev-parse", "HEAD"]).trim();
}

/** Captures HEAD, refs, index bytes and working-tree bytes; works for linked worktrees too. */
export function captureRepositoryState(root: string): RepositoryState {
  const headPath = gitPath(root, "HEAD");
  const indexPath = gitPath(root, "index");

  return {
    head: fs.readFileSync(headPath, "utf8"),
    refs: runFixtureGit(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    index: fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null,
    files: new Map(workingTreeFiles(root, "")),
  };
}

export function disposeHistoryRepository(fixture: HistoryRepositoryFixture): void {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

/**
 * Process environment without inherited `GIT_*` variables (e.g. `GIT_DIR` from a hook), user/system configuration
 * or replace objects, with deterministic dates. Pass it as `env` to `runHistoryGit` in tests so a developer's
 * `~/.gitconfig` cannot change output.
 */
export function fixtureGitEnvironment(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"));
  return {
    ...Object.fromEntries(inherited),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_DATE: FIXTURE_DEFAULT_DATE,
    GIT_COMMITTER_DATE: FIXTURE_DEFAULT_DATE,
  };
}

/** Stages one change; `--literal-pathspecs` keeps names such as `:x` or `*.txt` from acting as pathspec magic. */
function applyChange(root: string, change: FixtureFileChange): void {
  const absolutePath = path.join(root, change.path);
  if (change.kind === "delete") {
    runFixtureGit(root, ["--literal-pathspecs", "rm", "-q", "--", change.path]);
    return;
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, change.content);
  const chmodFlag = change.isExecutable === undefined ? [] : [change.isExecutable ? "--chmod=+x" : "--chmod=-x"];
  runFixtureGit(root, ["--literal-pathspecs", "add", ...chmodFlag, "--", change.path]);
}

function gitPath(root: string, name: string): string {
  return runFixtureGit(root, ["rev-parse", "--path-format=absolute", "--git-path", name]).trim();
}

function workingTreeFiles(root: string, relativeDirectory: string): Array<[string, Buffer]> {
  return fs
    .readdirSync(path.join(root, relativeDirectory), { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(root, relativePath);
      if (entry.isDirectory()) {
        return workingTreeFiles(root, relativePath);
      }
      if (entry.isSymbolicLink()) {
        return [[relativePath, Buffer.from(fs.readlinkSync(absolutePath))]];
      }
      return [[relativePath, fs.readFileSync(absolutePath)]];
    });
}
