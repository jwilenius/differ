import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runHistoryGit } from "./historyGitCommand";
import type { HistoryGitResult } from "./historyGitCommand";
import type { ReplayStep, ReplayTree, ResolvedHistoryComparison } from "./historyComparisonResolver";

const TEMPORARY_PREFIX = "differ-replay-";
const CLEANUP_RETRIES = 3;
const STORAGE_FAILURE_MESSAGE = "Could not prepare a temporary repository for the comparison.";
const QUOTE_BYTE = 0x22;
const BACKSLASH_BYTE = 0x5c;
const NEWLINE_BYTE = 0x0a;
const GIT_DIRECTORY_NAME = "repo.git";
const INDEX_FILE_NAME = "index";

/** Configuration forced on every private command, overriding anything Git could otherwise pick up. */
const PRIVATE_CONFIGURATION: ReadonlyArray<readonly [string, string]> = [
  ["core.attributesFile", os.devNull],
  ["core.sparseCheckout", "false"],
];

/** A patch exactly as Git recorded it: binary-safe, unabbreviated and free of user diff drivers. */
const PATCH_OPTIONS = [
  "--no-commit-id",
  "-r",
  "-p",
  "--binary",
  "--full-index",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--no-color",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--ignore-submodules=none",
  "--submodule=short",
] as const;
const APPLY_ARGS = ["-c", "apply.ignoreWhitespace=no", "apply", "--cached", "--3way", "--whitespace=nowarn", "-"];
const APPLY_FAILED_EXIT_CODE = 1;

const CONFLICT_EXPLANATION = "This commit's changes conflict with the changes replayed before it. "
  + "Change the selection, base or merge parent and compare again.";
const APPLY_FAILED_EXPLANATION = "This commit's changes could not be applied to the files replayed before it. "
  + "Change the selection, base or merge parent and compare again.";

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

/** A completed replay whose trees stay readable until `dispose`. */
export interface ReplaySession {
  readonly repository: PrivateRepository;
  readonly baseTreeOid: string;
  readonly resultTreeOid: string;
  /** Deletes the private repository; repeated calls are harmless. */
  dispose(): Promise<void>;
}

export interface ReplayedResult {
  readonly kind: "replayed";
  readonly session: ReplaySession;
}

/** Replay stopped at the first selected commit that did not apply; nothing of it remains on disk. */
export interface ReplayBlockedResult {
  readonly kind: "blocked";
  readonly failingOid: string;
  readonly paths: readonly string[];
  readonly explanation: string;
}

export type ReplayResult = ReplayedResult | ReplayBlockedResult;

/** Options for `replaySelection`, and for `GitComparisonRepository`, which forwards them to every replay. */
export interface ReplayOptions {
  /** Environment for reading the source repository; private commands use a sanitized copy of it. */
  readonly env?: NodeJS.ProcessEnv;
  /** Parent of the private temporary directory; the OS temporary directory when absent. */
  readonly temporaryParent?: string;
  /**
   * Receives failures to delete private files, after a failed or blocked replay or once a released snapshot is no
   * longer read, e.g. for host logging.
   */
  readonly onCleanupError?: (error: unknown) => void;
}

interface PrivateGitOptions {
  readonly stdin?: Uint8Array;
  readonly allowedExitCodes?: readonly number[];
}

interface SourceStorage {
  /** Raw path bytes, so a non-UTF-8 directory name survives into the alternates file. */
  readonly objectsDirectory: Buffer;
  readonly objectFormat: string;
}

interface ReplayedTrees {
  readonly kind: "replayed";
  readonly baseTreeOid: string;
  readonly resultTreeOid: string;
}

/**
 * Replays only the selected commits' patches onto the comparison base inside a fresh private repository that borrows
 * the source objects read-only. The source repository's refs, index, working tree and configuration are never used
 * for writing or executing anything. Stops at the first patch that does not apply; never returns a partial result.
 */
export async function replaySelection(
  root: string,
  comparison: ResolvedHistoryComparison,
  signal: AbortSignal,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const source = await readSourceStorage(root, signal, options.env);
  const temporaryParent = options.temporaryParent ?? os.tmpdir();
  const createdDirectory = await privateStorage(() => fs.mkdtemp(path.join(temporaryParent, TEMPORARY_PREFIX)));
  const dispose = (): Promise<void> => removeDirectory(createdDirectory);

  let isKept = false;
  try {
    // Git prints resolved paths, so redaction must match the real path rather than a symlinked temporary parent.
    const temporaryDirectory = await privateStorage(() => fs.realpath(createdDirectory));
    const repository = await initializePrivateRepository(temporaryDirectory, source, signal, options.env);
    const outcome = await replaySteps(repository, comparison, signal);
    if (outcome.kind === "blocked") {
      return outcome;
    }

    isKept = true;
    const { baseTreeOid, resultTreeOid } = outcome;
    return { kind: "replayed", session: { repository, baseTreeOid, resultTreeOid, dispose } };
  } finally {
    if (!isKept) {
      // A cleanup failure must not replace the result or the error that got here.
      await dispose().catch((error: unknown) => options.onCleanupError?.(error));
    }
  }
}

/** Runs Git inside a private repository with its confined environment and its paths redacted from messages. */
export function runPrivateGit(
  repository: PrivateRepository,
  args: readonly string[],
  signal: AbortSignal,
  options: PrivateGitOptions = {},
): Promise<HistoryGitResult> {
  return runHistoryGit({
    cwd: repository.temporaryDirectory,
    args,
    signal,
    env: repository.env,
    // Git for Windows may print the path with forward slashes.
    redactedPaths: [repository.temporaryDirectory, repository.temporaryDirectory.replaceAll("\\", "/")],
    ...options,
  });
}

/**
 * Process environment with every inherited `GIT_*` variable removed (repository/index/object locations, alternates,
 * `GIT_CONFIG_*` overrides, tracing), user/system configuration and attributes disabled, and the private locations set.
 * Matching is case-insensitive because Windows environment names are.
 */
function privateGitEnvironment(
  inherited: NodeJS.ProcessEnv,
  gitDirectory: string,
  indexFile: string,
): NodeJS.ProcessEnv {
  const kept = Object.entries(inherited).filter(([name]) => !name.toUpperCase().startsWith("GIT_"));
  const configuration = PRIVATE_CONFIGURATION.flatMap(([key, value], index) => [
    [`GIT_CONFIG_KEY_${index}`, key],
    [`GIT_CONFIG_VALUE_${index}`, value],
  ]);

  return {
    ...Object.fromEntries(kept),
    GIT_DIR: gitDirectory,
    GIT_INDEX_FILE: indexFile,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_CONFIG_COUNT: String(PRIVATE_CONFIGURATION.length),
    ...Object.fromEntries(configuration),
  };
}

/**
 * One line of an `objects/info/alternates` file. Git C-unquotes a line starting with `"`, so newlines, quotes and
 * backslashes inside the path stay literal.
 */
function quoteAlternatePath(directory: Buffer): Buffer {
  const quoted = [...directory].map((byte) => {
    if (byte === QUOTE_BYTE || byte === BACKSLASH_BYTE) {
      return Buffer.from([BACKSLASH_BYTE, byte]);
    }
    const isControl = byte < 0x20 || byte === 0x7f;
    return isControl ? Buffer.from(`\\${byte.toString(8).padStart(3, "0")}`, "ascii") : Buffer.from([byte]);
  });
  return Buffer.concat([Buffer.from("\""), ...quoted, Buffer.from("\"")]);
}

/** Uses the same replace-object policy as planning, so replay sees the exact objects the plan named. */
async function readSourceStorage(root: string, signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<SourceStorage> {
  const sourceGit = (args: readonly string[]): Promise<HistoryGitResult> =>
    runHistoryGit({ cwd: root, args, signal, ...(env === undefined ? {} : { env }) });

  const objectsResult = await sourceGit(["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  const formatResult = await sourceGit(["rev-parse", "--show-object-format"]);
  return {
    objectsDirectory: withoutFinalNewline(objectsResult.stdout),
    objectFormat: formatResult.stdout.toString("utf8").trim(),
  };
}

async function initializePrivateRepository(
  temporaryDirectory: string,
  source: SourceStorage,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PrivateRepository> {
  const gitDirectory = path.join(temporaryDirectory, GIT_DIRECTORY_NAME);
  const indexFile = path.join(temporaryDirectory, INDEX_FILE_NAME);
  const repository = { temporaryDirectory, gitDirectory, env: privateGitEnvironment(env, gitDirectory, indexFile) };

  // `GIT_DIR` names the repository to create; an empty template installs no hooks.
  const initArgs = ["init", "-q", "--bare", "--template=", `--object-format=${source.objectFormat}`];
  await runPrivateGit(repository, initArgs, signal);
  const infoDirectory = path.join(gitDirectory, "objects", "info");
  const alternates = Buffer.concat([quoteAlternatePath(source.objectsDirectory), Buffer.from("\n")]);
  await privateStorage(async () => {
    await fs.mkdir(infoDirectory, { recursive: true });
    await fs.writeFile(path.join(infoDirectory, "alternates"), alternates);
  });
  return repository;
}

async function replaySteps(
  repository: PrivateRepository,
  comparison: ResolvedHistoryComparison,
  signal: AbortSignal,
): Promise<ReplayedTrees | ReplayBlockedResult> {
  const emptyTreeOid = await writeEmptyTree(repository, signal);
  const treeOid = (tree: ReplayTree): string => tree.kind === "commit" ? tree.treeOid : emptyTreeOid;

  await runPrivateGit(repository, ["read-tree", treeOid(comparison.baseTree)], signal);
  const baseTreeOid = await writeTree(repository, signal);

  for (const step of comparison.steps) {
    const blocked = await applyStep(repository, treeOid(step.parent), step, signal);
    if (blocked !== null) {
      return blocked;
    }
  }
  return { kind: "replayed", baseTreeOid, resultTreeOid: await writeTree(repository, signal) };
}

/** Applies one commit's parent-relative patch to the index; an empty patch or an unchanged tree is a no-op. */
async function applyStep(
  repository: PrivateRepository,
  parentTreeOid: string,
  step: ReplayStep,
  signal: AbortSignal,
): Promise<ReplayBlockedResult | null> {
  const patchArgs = ["diff-tree", ...PATCH_OPTIONS, parentTreeOid, step.treeOid, "--"];
  const patch = await runPrivateGit(repository, patchArgs, signal);
  if (patch.stdout.length === 0) {
    return null;
  }

  const applyOptions = { stdin: patch.stdout, allowedExitCodes: [0, APPLY_FAILED_EXIT_CODE] };
  const applied = await runPrivateGit(repository, APPLY_ARGS, signal, applyOptions);
  if (applied.exitCode === 0) {
    return null;
  }
  return describeBlockedStep(repository, parentTreeOid, step, signal);
}

/** Conflicting paths when the three-way merge left any; otherwise every path the commit touches. */
async function describeBlockedStep(
  repository: PrivateRepository,
  parentTreeOid: string,
  step: ReplayStep,
  signal: AbortSignal,
): Promise<ReplayBlockedResult> {
  const unmerged = await runPrivateGit(repository, ["ls-files", "--unmerged", "-z"], signal);
  const conflictPaths = unique(nulFields(unmerged.stdout).map((entry) => entry.slice(entry.indexOf("\t") + 1)));
  if (conflictPaths.length > 0) {
    return { kind: "blocked", failingOid: step.oid, paths: conflictPaths, explanation: CONFLICT_EXPLANATION };
  }

  const nameOptions = ["--no-commit-id", "-r", "--name-only", "-z", "--no-renames"];
  const nameArgs = ["diff-tree", ...nameOptions, parentTreeOid, step.treeOid, "--"];
  const changed = await runPrivateGit(repository, nameArgs, signal);
  const paths = nulFields(changed.stdout);
  return { kind: "blocked", failingOid: step.oid, paths, explanation: APPLY_FAILED_EXPLANATION };
}

async function writeEmptyTree(repository: PrivateRepository, signal: AbortSignal): Promise<string> {
  const args = ["hash-object", "-t", "tree", "-w", "--stdin"];
  const result = await runPrivateGit(repository, args, signal, { stdin: new Uint8Array() });
  return result.stdout.toString("utf8").trim();
}

async function writeTree(repository: PrivateRepository, signal: AbortSignal): Promise<string> {
  const result = await runPrivateGit(repository, ["write-tree"], signal);
  return result.stdout.toString("utf8").trim();
}

function nulFields(output: Buffer): readonly string[] {
  return output.toString("utf8").split("\0").filter((field) => field !== "");
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function withoutFinalNewline(output: Buffer): Buffer {
  return output.at(-1) === NEWLINE_BYTE ? output.subarray(0, -1) : output;
}

/** Runs a filesystem step on private files, replacing its error, whose message names private paths. */
async function privateStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new HistoryReplayStorageError(error instanceof Error ? error.message : String(error));
  }
}

function removeDirectory(directory: string): Promise<void> {
  return fs.rm(directory, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
}
