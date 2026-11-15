import { HistoryGitError, runHistoryGit, sourceRepositoryEnvironment } from "./historyGitCommand";

/** Git's exit code for a fatal error, which is how it reports a directory outside any repository. */
const FATAL_EXIT_CODE = 128;
/**
 * Git's untranslated message for a directory in no repository. A fatal exit alone does not tell that apart from a
 * repository Git refuses, as an unsafe one, so the message is read with messages untranslated.
 */
const NOT_A_REPOSITORY_MESSAGE = "not a git repository";
/** Selects Git's untranslated messages; `LANGUAGE` is set too, as gettext otherwise lets it override the locale. */
const UNTRANSLATED_MESSAGES: NodeJS.ProcessEnv = { LC_ALL: "C", LANGUAGE: "C" };

/**
 * Runs `read`, a Git read in `directory`, or returns `outside` when it fails because `directory` is outside any work
 * tree: in no repository, or in one without a work tree, such as a git directory. Any other failure, such as an
 * unreadable index or a repository Git refuses as unsafe, propagates as the `HistoryGitError` it raised.
 */
export async function readInWorkTree<T>(directory: string, read: () => Promise<T>, outside: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const isFatalGitError = error instanceof HistoryGitError && error.exitCode === FATAL_EXIT_CODE;
    if (isFatalGitError && (await isOutsideWorkTree(directory))) {
      return outside;
    }
    throw error;
  }
}

/**
 * Whether `directory` is outside any work tree. Git answers "false" inside a repository that has none and fails with
 * its untranslated "not a git repository" message in no repository; every other failure leaves the question open.
 */
async function isOutsideWorkTree(directory: string): Promise<boolean> {
  const result = await runHistoryGit({
    cwd: directory,
    args: ["rev-parse", "--is-inside-work-tree"],
    env: { ...sourceRepositoryEnvironment(process.env), ...UNTRANSLATED_MESSAGES },
    allowedExitCodes: [0, FATAL_EXIT_CODE],
  });
  if (result.exitCode === 0) {
    return result.stdout.toString("utf8").trim() === "false";
  }
  return result.stderr.toString("utf8").includes(NOT_A_REPOSITORY_MESSAGE);
}
