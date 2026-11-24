/** Private temporary files of a replay: the repository they hold and how their failures are reported. */

const STORAGE_FAILURE_MESSAGE = "Could not prepare a temporary repository for the comparison.";

/** A filesystem step on private files failed; `message` is safe to show, `detail` names private paths for logging. */
export class HistoryReplayStorageError extends Error {
  constructor(readonly detail: string) {
    super(STORAGE_FAILURE_MESSAGE);
    this.name = "HistoryReplayStorageError";
  }
}

/** A private bare repository plus the environment that confines Git to it. */
export interface PrivateRepository {
  /** Owns the repository and its index; redacted from user-facing messages. */
  readonly temporaryDirectory: string;
  readonly gitDirectory: string;
  /** Complete child environment: sanitized, with `GIT_DIR` and `GIT_INDEX_FILE` pointing into the private files. */
  readonly env: NodeJS.ProcessEnv;
}

/** Runs a filesystem step on private files, replacing its error, whose message names private paths. */
export async function privateStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new HistoryReplayStorageError(error instanceof Error ? error.message : String(error));
  }
}
