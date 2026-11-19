import * as os from "node:os";
import * as vscode from "vscode";
import { HistoryGitError, PLAIN_GIT, runHistoryGit } from "../../git/historyGitCommand";

const GIT_EXTENSION_ID = "vscode.git";
const GIT_API_VERSION = 1;
const GIT_SETTINGS_SECTION = "git";
const GIT_PATH_KEY = "path";
const GIT_PATH_SETTING = `${GIT_SETTINGS_SECTION}.${GIT_PATH_KEY}`;
/**
 * How long a Git call waits for the lookup before starting Git on `PATH`. Covers a slow start of the Git extension or
 * a slow `git.path` probe, while a lookup that never finishes delays each call by at most this.
 */
export const GIT_LOOKUP_TIMEOUT_MS = 5_000;
/** How long a `git.path` entry may take to answer `--version`; `git --version` normally takes milliseconds. */
export const GIT_PROBE_TIMEOUT_MS = 3_000;

/**
 * The members of the built-in Git extension's exports that jw-differ reads, as declared in VS Code's
 * `extensions/git/src/api/git.d.ts`. `enabled` is false while `git.enabled` is off and when the extension found no Git;
 * `getAPI` throws then.
 */
interface GitExtensionExports {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: typeof GIT_API_VERSION): { readonly git: { readonly path: string } };
}

/** Whether `executable` starts and runs as Git; injectable so tests need not depend on installed executables. */
export type GitExecutableProbe = (executable: string) => Promise<boolean>;

/** One search for Git and the moment callers stop waiting for it; both settle with an executable. */
interface GitLookup {
  readonly found: Promise<string>;
  /**
   * Settles with `git` on `PATH` once the search has run for `GIT_LOOKUP_TIMEOUT_MS`, or with the found Git when the
   * search finishes first, so the `Promise.race` of each call is released rather than kept by a never-settled deadline.
   */
  readonly overdue: Promise<string>;
}

/** A Git executable and where it came from, for the log. */
interface LocatedGit {
  readonly executable: string;
  readonly origin: string;
}

/**
 * Finds the Git that VS Code's Source Control uses, so jw-differ works wherever Source Control does, as with Git for
 * Windows installed for Git Bash only, off `PATH`. The order:
 *
 * 1. The path the built-in Git extension found (`getAPI(1).git.path`), activating the extension first if need be. It
 *    tried each `git.path` entry, then on Windows the `Git\cmd\git.exe` of Program Files and `%LocalAppData%\Programs`
 *    before `PATH`, on macOS `which git`, elsewhere `git` (`findGit` in VS Code's `extensions/git/src/git.ts`).
 * 2. When that extension is disabled, off (`git.enabled`), failed or found no Git: the first `git.path` entry that
 *    runs.
 * 3. `git`, looked up on `PATH`.
 *
 * The answer is kept until `git.path` changes or the Git extension is enabled or disabled. While a search runs longer
 * than `GIT_LOOKUP_TIMEOUT_MS`, calls use `git` on `PATH` without keeping it, and get the found Git once the search
 * finishes. In a remote window both extensions run on the remote, so the remote's Git is found.
 */
export class GitExecutableLocator implements vscode.Disposable {
  private lookup: GitLookup | null = null;
  private enablementSubscription: vscode.Disposable | null = null;
  private isDisposed = false;
  private readonly configurationSubscription: vscode.Disposable;

  constructor(
    private readonly log: (line: string) => void,
    private readonly isRunnableGit: GitExecutableProbe = runsAsGit,
  ) {
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(GIT_PATH_SETTING)) {
        this.forget();
      }
    });
  }

  /** The Git executable to start; never rejects, falling back to `git` on `PATH`. */
  locate(): Promise<string> {
    this.lookup ??= this.startLookup();
    // Listed first, a finished search wins over a deadline that has passed too, as `Promise.race` settles in order.
    return Promise.race([this.lookup.found, this.lookup.overdue]);
  }

  dispose(): void {
    this.isDisposed = true;
    this.configurationSubscription.dispose();
    this.enablementSubscription?.dispose();
    this.enablementSubscription = null;
  }

  private forget(): void {
    this.lookup = null;
  }

  private startLookup(): GitLookup {
    const found = this.find();
    const overdue = new Promise<string>((resolve) => {
      const deadline = setTimeout(() => {
        this.log(`Finding Git takes over ${GIT_LOOKUP_TIMEOUT_MS} ms; using ${PLAIN_GIT} on PATH until it finishes.`);
        resolve(PLAIN_GIT);
      }, GIT_LOOKUP_TIMEOUT_MS);
      void found.then((executable) => {
        clearTimeout(deadline);
        resolve(executable);
      });
    });
    return { found, overdue };
  }

  private async find(): Promise<string> {
    const { executable, origin } = await this.findLocatedGit().catch((error: unknown) => ({
      executable: PLAIN_GIT,
      origin: `looked up on PATH, as finding Git failed: ${errorMessage(error)}`,
    }));
    this.log(`Using Git ${executable} (${origin}).`);
    return executable;
  }

  private async findLocatedGit(): Promise<LocatedGit> {
    const extensionGit = await this.gitExtensionPath();
    if (extensionGit !== null) {
      return { executable: extensionGit, origin: "found by VS Code's Git extension" };
    }
    const configuredGit = await this.firstRunnableGit(configuredGitPaths());
    if (configuredGit !== null) {
      return { executable: configuredGit, origin: `from the "${GIT_PATH_SETTING}" setting` };
    }
    return { executable: PLAIN_GIT, origin: "looked up on PATH" };
  }

  /** The path the Git extension found; null when it is unavailable, off or found none. */
  private async gitExtensionPath(): Promise<string | null> {
    const extension = vscode.extensions.getExtension<GitExtensionExports | undefined>(GIT_EXTENSION_ID);
    if (extension === undefined) {
      return null;
    }
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      if (exports === undefined) {
        return null;
      }
      if (!this.isDisposed) {
        this.enablementSubscription ??= exports.onDidChangeEnablement(() => this.forget());
      }
      return exports.enabled ? exports.getAPI(GIT_API_VERSION).git.path : null;
    } catch (error) {
      // An extension whose activation or API fails leaves jw-differ to find Git itself.
      this.log(`VS Code's Git extension did not provide its Git: ${errorMessage(error)}`);
      return null;
    }
  }

  /** The first of `candidates` that runs as Git, tried in order as the Git extension does; null when none does. */
  private async firstRunnableGit(candidates: readonly string[]): Promise<string | null> {
    for (const candidate of candidates) {
      if (await this.isRunnableGit(candidate)) {
        return candidate;
      }
      this.log(`The "${GIT_PATH_SETTING}" entry ${candidate} does not run as Git.`);
    }
    return null;
  }
}

/** The `git.path` setting's entries: one path, or a list tried in order; anything but non-empty strings is ignored. */
function configuredGitPaths(): readonly string[] {
  const setting = vscode.workspace.getConfiguration(GIT_SETTINGS_SECTION).get<unknown>(GIT_PATH_KEY);
  const entries: readonly unknown[] = Array.isArray(setting) ? setting : [setting];
  return entries.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `<executable> --version`, as the Git extension validates each `git.path` entry. One that has not answered
 * within `GIT_PROBE_TIMEOUT_MS` is killed and does not count as Git.
 */
async function runsAsGit(executable: string): Promise<boolean> {
  const timeout = new AbortController();
  const deadline = setTimeout(() => timeout.abort(), GIT_PROBE_TIMEOUT_MS);
  try {
    await runHistoryGit({ cwd: os.tmpdir(), args: ["--version"], executable, signal: timeout.signal });
    return true;
  } catch (error) {
    if (error instanceof HistoryGitError) {
      return false;
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
