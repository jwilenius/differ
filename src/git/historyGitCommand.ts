import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

/** Maximum bytes accepted on each of stdout and stderr before the child is killed. */
export const HISTORY_GIT_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

const REDACTED_PATH = "<temporary repository>";
const MESSAGE_STDERR_LIMIT_CHARS = 500;
const DEFAULT_ALLOWED_EXIT_CODES: readonly number[] = [0];

/**
 * Inherited variables that relocate the repository, index or objects, or inject configuration. Source-repository reads
 * drop them so Git discovers the repository from the requested directory with only the user's normal configuration.
 */
const LOCATION_AND_CONFIG_VARIABLES: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
]);
const CONFIG_ENTRY_VARIABLE_PATTERN = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

export interface HistoryGitSpawnOptions {
  /** Always a fixed safe directory; the requested directory reaches Git as `-C`. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Starts `git` with the given arguments; injectable so tests can simulate child processes. */
export type SpawnHistoryGit = (
  args: readonly string[],
  options: HistoryGitSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface HistoryGitOptions {
  /**
   * Directory Git runs in, passed as `-C`. The child process itself starts in the OS temporary directory, because
   * Windows looks up `git.exe` in the child's working directory before `PATH`, which would run an executable planted
   * in an untrusted repository.
   */
  readonly cwd: string;
  readonly args: readonly string[];
  /** Exact bytes written to the child's stdin; stdin is closed immediately when absent. */
  readonly stdin?: Uint8Array;
  /**
   * Complete child environment, used verbatim. When absent the process environment is inherited without variables
   * that relocate the repository or inject configuration, with `GIT_NO_REPLACE_OBJECTS=1` so reads see the
   * repository's real objects and `GIT_NO_LAZY_FETCH=1` so a partial clone never fetches missing objects over the
   * network (honoured from Git 2.44; a no-op before).
   */
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Exit codes that resolve rather than reject. Defaults to `[0]`. */
  readonly allowedExitCodes?: readonly number[];
  /**
   * Internal paths replaced in user-facing error messages; `HistoryGitError.detail` keeps them. Callers working in a
   * private temporary repository pass its paths on every call.
   */
  readonly redactedPaths?: readonly string[];
  readonly spawnProcess?: SpawnHistoryGit;
}

export interface HistoryGitResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
}

export type HistoryGitErrorKind = "missingGit" | "cancelled" | "outputLimitExceeded" | "failed";

/** A Git invocation that did not produce an allowed result. `message` is safe to show to users. */
export class HistoryGitError extends Error {
  constructor(
    message: string,
    readonly kind: HistoryGitErrorKind,
    /** Unredacted invocation details for host logging only. */
    readonly detail: string,
    readonly exitCode: number | null = null,
    readonly stderr: Buffer = Buffer.alloc(0),
  ) {
    super(message);
    this.name = "HistoryGitError";
  }
}

/**
 * Runs Git without a shell, collecting binary output. Settles only after the child has terminated, including on
 * abort and output overflow, both of which kill the child.
 */
export async function runHistoryGit(options: HistoryGitOptions): Promise<HistoryGitResult> {
  await assertDirectoryExists(options);
  if (options.signal?.aborted) {
    throw cancelledError(options);
  }

  const child = startGit(options);
  return new Promise<HistoryGitResult>((resolve, reject) => {
    const run = new GitChildRun(child, options, (outcome) => {
      if (outcome instanceof HistoryGitError) {
        reject(outcome);
        return;
      }
      resolve(outcome);
    });
    run.start();
  });
}

/** Reports a missing directory before Git starts, as Node did when it was the child's working directory. */
async function assertDirectoryExists(options: HistoryGitOptions): Promise<void> {
  try {
    await fs.promises.stat(options.cwd);
  } catch (error) {
    const reason = (error as Error).message;
    const message = redact(`Git ${commandName(options)} could not start: ${reason}`, options);
    throw new HistoryGitError(message, "failed", describeInvocation(options, reason));
  }
}

function startGit(options: HistoryGitOptions): ChildProcessWithoutNullStreams {
  const spawnProcess = options.spawnProcess ?? spawnGit;
  const env = options.env ?? sourceRepositoryEnvironment(process.env);
  try {
    return spawnProcess(["-C", options.cwd, ...options.args], { cwd: os.tmpdir(), env });
  } catch (error) {
    throw spawnError(options, error as NodeJS.ErrnoException);
  }
}

function spawnGit(args: readonly string[], options: HistoryGitSpawnOptions): ChildProcessWithoutNullStreams {
  const { cwd, env } = options;
  return spawn("git", [...args], { cwd, env, shell: false, stdio: "pipe", windowsHide: true });
}

/** The inherited environment for reading a user's repository. Matching is case-insensitive as on Windows. */
function sourceRepositoryEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(inherited).filter(([name]) => {
    const upperName = name.toUpperCase();
    return !LOCATION_AND_CONFIG_VARIABLES.has(upperName) && !CONFIG_ENTRY_VARIABLE_PATTERN.test(upperName);
  });
  return { ...Object.fromEntries(kept), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
}

/**
 * Watches one started child: collects its output, kills it on abort or overflow and reports exactly one outcome once
 * it has terminated.
 */
class GitChildRun {
  private readonly stdout = new OutputCollector();
  private readonly stderr = new OutputCollector();
  /** Set when this run killed the child; reported once the child has closed. */
  private pendingError: HistoryGitError | null = null;
  private readonly onAbort = (): void => this.terminate(cancelledError(this.options));

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: HistoryGitOptions,
    private readonly settle: (outcome: HistoryGitResult | HistoryGitError) => void,
  ) {}

  start(): void {
    this.options.signal?.addEventListener("abort", this.onAbort, { once: true });
    this.child.stdout.on("data", (chunk: Buffer) => this.collect(this.stdout, chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.collect(this.stderr, chunk));
    this.child.on("error", (error: NodeJS.ErrnoException) => this.onError(error));
    this.child.on("close", (exitCode: number | null) => this.onClose(exitCode));
    writeStdin(this.child, this.options.stdin);
  }

  private collect(collector: OutputCollector, chunk: Buffer): void {
    if (this.pendingError !== null) {
      return;
    }
    const hasRoom = collector.append(chunk);
    if (!hasRoom) {
      this.terminate(outputLimitError(this.options));
    }
  }

  private terminate(error: HistoryGitError): void {
    if (this.pendingError !== null) {
      return;
    }
    this.pendingError = error;
    this.child.kill();
  }

  private onError(error: NodeJS.ErrnoException): void {
    // A running child that failed to be killed still reports "close" once it terminates.
    const isRunningChild = this.pendingError !== null && this.child.pid !== undefined;
    if (isRunningChild) {
      return;
    }
    this.finish(spawnError(this.options, error));
  }

  private onClose(exitCode: number | null): void {
    if (this.pendingError !== null) {
      this.finish(this.pendingError);
      return;
    }
    this.finish(exitResult(this.options, exitCode, this.stdout.bytes(), this.stderr.bytes()));
  }

  /** Later calls are harmless: the promise behind `settle` settles once. */
  private finish(outcome: HistoryGitResult | HistoryGitError): void {
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.settle(outcome);
  }
}

/** Accumulates one output stream up to the history output limit. */
class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  /** Returns false, without storing the chunk, when it would exceed the limit. */
  append(chunk: Buffer): boolean {
    if (this.size + chunk.length > HISTORY_GIT_OUTPUT_LIMIT_BYTES) {
      return false;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    return true;
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

function writeStdin(child: ChildProcessWithoutNullStreams, stdin: Uint8Array | undefined): void {
  // A child that exits without reading stdin raises EPIPE here; its exit code already reports the outcome.
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin);
}

function exitResult(
  options: HistoryGitOptions,
  exitCode: number | null,
  stdout: Buffer,
  stderr: Buffer,
): HistoryGitResult | HistoryGitError {
  const allowedExitCodes = options.allowedExitCodes ?? DEFAULT_ALLOWED_EXIT_CODES;
  if (exitCode !== null && allowedExitCodes.includes(exitCode)) {
    return { stdout, stderr, exitCode };
  }

  const stderrText = stderr.toString("utf8").trim();
  const exitDescription = exitCode === null ? "was terminated" : `exited with code ${exitCode}`;
  const summary = `Git ${commandName(options)} ${exitDescription}`;
  const shortStderr = stderrText.slice(0, MESSAGE_STDERR_LIMIT_CHARS);
  const message = shortStderr === "" ? summary : `${summary}: ${shortStderr}`;
  const detail = describeInvocation(options, `${summary}: ${stderrText}`);
  return new HistoryGitError(redact(message, options), "failed", detail, exitCode, stderr);
}

function spawnError(options: HistoryGitOptions, error: NodeJS.ErrnoException): HistoryGitError {
  const detail = describeInvocation(options, error.message);
  // The child always starts in the existing temporary directory, so ENOENT can only mean Git itself is missing.
  const isGitMissing = error.code === "ENOENT";
  if (isGitMissing) {
    return new HistoryGitError("Git executable was not found on PATH.", "missingGit", detail);
  }
  const message = redact(`Git ${commandName(options)} could not start: ${error.message}`, options);
  return new HistoryGitError(message, "failed", detail);
}

function cancelledError(options: HistoryGitOptions): HistoryGitError {
  const message = `Git ${commandName(options)} was cancelled.`;
  return new HistoryGitError(message, "cancelled", describeInvocation(options, message));
}

function outputLimitError(options: HistoryGitOptions): HistoryGitError {
  const limitMiB = HISTORY_GIT_OUTPUT_LIMIT_BYTES / (1024 * 1024);
  const message = `Git ${commandName(options)} produced more than ${limitMiB} MiB of output.`;
  return new HistoryGitError(message, "outputLimitExceeded", describeInvocation(options, message));
}

/** The subcommand, skipping global options such as `-c name=value` and `-C path`. */
function commandName(options: HistoryGitOptions): string {
  const subcommand = options.args.find((arg, index) => {
    const previous = options.args[index - 1];
    const isOptionValue = previous === "-c" || previous === "-C";
    return !arg.startsWith("-") && !isOptionValue;
  });
  return redact(subcommand ?? "command", options);
}

function describeInvocation(options: HistoryGitOptions, reason: string): string {
  return `git ${options.args.join(" ")} (cwd ${options.cwd}): ${reason}`;
}

function redact(text: string, options: HistoryGitOptions): string {
  const paths = (options.redactedPaths ?? []).filter((internalPath) => internalPath !== "");
  return paths.reduce((redacted, internalPath) => redacted.split(internalPath).join(REDACTED_PATH), text);
}
