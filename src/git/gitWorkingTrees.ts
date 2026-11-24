import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkingChangeStatus, WORKING_TREE_READ_OPTIONS } from "./gitWorkingChangeStatus";
import type { WorkingTreeGit } from "./gitWorkingChangeStatus";
import { HistoryGitError, runHistoryGit, sourceRepositoryEnvironment } from "./historyGitCommand";
import type { HistoryGitResult } from "./historyGitCommand";
import { privateStorage } from "./gitReplayStorage";
import type { PrivateRepository } from "./gitReplayStorage";

const STAGED_INDEX_NAME = "staged-index";
const WORKTREE_INDEX_NAME = "worktree-index";
/** Never created: pointing `core.hooksPath` at it leaves Git without any hook to run. */
const NO_HOOKS_NAME = "no-hooks";
const NEWLINE_BYTE = 0x0a;
const TAB = "\t";
const OURS_STAGE = "2";
const SHA256_FORMAT = "sha256";
const SHA1_HEX_LENGTH = 40;
const SHA256_HEX_LENGTH = 64;

/**
 * Settings that keep a private index copy self-contained: written whole rather than split into a shared index in the
 * source repository, expanded rather than sparse, and read without a file-system monitor.
 */
const PRIVATE_INDEX_OPTIONS = [
  ...WORKING_TREE_READ_OPTIONS,
  "-c",
  "core.splitIndex=false",
  "-c",
  "index.sparse=false",
] as const;

/** Trees of the index and of the files on disk, written into a private repository only. */
export interface WorkingTrees {
  readonly indexTreeOid: string;
  /** Null unless requested. */
  readonly worktreeTreeOid: string | null;
  /** More paths changed than status lists, so the tree of the files on disk may leave changes out. */
  readonly isWorktreeIncomplete: boolean;
}

/** Which repository's working tree to read, and what to build from it. */
export interface WorkingTreeSource {
  /** The source working tree; Git runs there so its configuration, attributes and clean filters apply. */
  readonly root: string;
  /** Environment for reading the source repository; the runner's read default when absent. */
  readonly env?: NodeJS.ProcessEnv;
  /** `sha1` or `sha256`, as `rev-parse --show-object-format` printed it. */
  readonly objectFormat: string;
  readonly isWorktreeIncluded: boolean;
}

/** One private index copy with the Git runner that reads and writes it from the source working tree. */
interface IndexCopy {
  readonly file: string;
  readonly git: (args: readonly string[], stdin?: Uint8Array) => Promise<HistoryGitResult>;
  readonly read: WorkingTreeGit;
}

/**
 * Writes the tree of the source index and, when asked, the tree of the files on disk, without writing to the source
 * repository: Git works on copies of the index inside `repository` and stores new objects only in its private object
 * directory, whose alternates file already borrows the source objects. Conflicted paths take HEAD's side (stage 2).
 * Submodule gitlinks stay as recorded. Clean filters and line-ending conversion apply as in `git add`.
 */
export async function writeWorkingTrees(
  repository: PrivateRepository,
  source: WorkingTreeSource,
  signal: AbortSignal,
): Promise<WorkingTrees> {
  const sourceIndex = await readSourceIndexPath(source, signal);
  const staged = indexCopy(repository, source, STAGED_INDEX_NAME, signal);
  // Status reads the conflicts before they are resolved; it is needed only for the tree of the files on disk.
  const { status, conflictedPaths } = await readCopiedIndex(sourceIndex, staged, async () => ({
    status: source.isWorktreeIncluded ? await readWorkingChangeStatus(staged.read) : null,
    conflictedPaths: await keepOurSide(staged, source.objectFormat),
  }));
  const indexTreeOid = await writeTree(staged);
  if (status === null) {
    return { indexTreeOid, worktreeTreeOid: null, isWorktreeIncomplete: false };
  }

  const worktree = indexCopy(repository, source, WORKTREE_INDEX_NAME, signal);
  await copyIndex(Buffer.from(staged.file), worktree.file);
  // Status stops at its path limit; only the index lists every conflict past it.
  const worktreePaths = uniquePaths([...status.worktreePaths, ...conflictedPaths]);
  if (worktreePaths.length > 0) {
    const pathInput = Buffer.concat(worktreePaths.flatMap((entry) => [entry, Buffer.from([0])]));
    await worktree.git(["update-index", "-z", "--add", "--remove", "--replace", "--stdin"], pathInput);
  }
  return { indexTreeOid, worktreeTreeOid: await writeTree(worktree), isWorktreeIncomplete: status.counts.isTruncated };
}

async function readSourceIndexPath(source: WorkingTreeSource, signal: AbortSignal): Promise<Buffer> {
  const args = ["rev-parse", "--path-format=absolute", "--git-path", "index"];
  const result = await runHistoryGit({ cwd: source.root, args, signal, ...(source.env === undefined ? {} : { env: source.env }) });
  const output = result.stdout;
  return output.at(-1) === NEWLINE_BYTE ? output.subarray(0, -1) : output;
}

/**
 * A Git runner in the source working tree whose index is `file` in the private directory and whose new objects go
 * to the private object directory. Writing the index copy would run the source repository's `post-index-change`
 * hook, so hooks are looked up in a missing private directory. Paths inside the private directory are redacted from
 * messages.
 */
function indexCopy(repository: PrivateRepository, source: WorkingTreeSource, name: string, signal: AbortSignal): IndexCopy {
  const file = path.join(repository.temporaryDirectory, name);
  const env: NodeJS.ProcessEnv = {
    ...sourceRepositoryEnvironment(source.env ?? process.env),
    GIT_INDEX_FILE: file,
    GIT_OBJECT_DIRECTORY: path.join(repository.gitDirectory, "objects"),
    GIT_OPTIONAL_LOCKS: "0",
  };
  const hooksOff = ["-c", `core.hooksPath=${path.join(repository.temporaryDirectory, NO_HOOKS_NAME)}`];
  const redactedPaths = [repository.temporaryDirectory, repository.temporaryDirectory.replaceAll("\\", "/")];
  const run = (args: readonly string[], stdin?: Uint8Array, allowedExitCodes?: readonly number[]): Promise<HistoryGitResult> =>
    runHistoryGit({
      cwd: source.root,
      args: [...PRIVATE_INDEX_OPTIONS, ...hooksOff, ...args],
      signal,
      env,
      redactedPaths,
      ...(stdin === undefined ? {} : { stdin }),
      ...(allowedExitCodes === undefined ? {} : { allowedExitCodes }),
    });
  return { file, git: (args, stdin) => run(args, stdin), read: (args, allowedExitCodes) => run(args, undefined, allowedExitCodes) };
}

/**
 * Copies the source index and runs `read` against the copy. Git replaces the index by renaming a new file over it, but
 * a copy taken mid-write elsewhere could still be unreadable, so one failed read is retried with a fresh copy.
 */
async function readCopiedIndex<T>(sourceIndex: Buffer, copy: IndexCopy, read: () => Promise<T>): Promise<T> {
  await copyIndex(sourceIndex, copy.file);
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof HistoryGitError && error.kind === "failed")) {
      throw error;
    }
    await copyIndex(sourceIndex, copy.file);
    return read();
  }
}

/** A repository without any index yet has nothing to copy; Git reads a missing index as empty. */
async function copyIndex(from: Buffer, to: string): Promise<void> {
  await privateStorage(async () => {
    try {
      await fs.copyFile(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await fs.rm(to, { force: true });
    }
  });
}

/**
 * Replaces each conflicted path's stages with HEAD's side (stage 2), or removes it when HEAD's side deleted it.
 * Returns the conflicted paths.
 */
async function keepOurSide(copy: IndexCopy, objectFormat: string): Promise<readonly Buffer[]> {
  const unmerged = await copy.git(["ls-files", "-z", "--unmerged"]);
  const zeroOid = "0".repeat(objectFormat === SHA256_FORMAT ? SHA256_HEX_LENGTH : SHA1_HEX_LENGTH);
  const entries = nulRecords(unmerged.stdout).map(parseUnmergedEntry);
  const paths = uniquePaths(entries.map((entry) => entry.path));
  if (paths.length === 0) {
    return paths;
  }

  const removals = paths.map((entryPath) => indexInfoLine(`0 ${zeroOid}`, entryPath));
  const ours = entries
    .filter((entry) => entry.stage === OURS_STAGE)
    .map((entry) => indexInfoLine(`${entry.mode} ${entry.oid}`, entry.path));
  await copy.git(["update-index", "-z", "--index-info"], Buffer.concat([...removals, ...ours]));
  return paths;
}

/** Raw paths in their first order, each once. */
function uniquePaths(paths: readonly Buffer[]): readonly Buffer[] {
  return [...new Map(paths.map((entry) => [entry.toString("latin1"), entry])).values()];
}

interface UnmergedEntry {
  readonly mode: string;
  readonly oid: string;
  readonly stage: string;
  readonly path: Buffer;
}

/** `<mode> SP <oid> SP <stage> TAB <path>`, the path kept as raw bytes. */
function parseUnmergedEntry(record: Buffer): UnmergedEntry {
  const tab = record.indexOf(TAB);
  const [mode = "", oid = "", stage = ""] = record.toString("latin1", 0, tab).split(" ");
  return { mode, oid, stage, path: record.subarray(tab + 1) };
}

function indexInfoLine(prefix: string, entryPath: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${prefix}${TAB}`, "latin1"), entryPath, Buffer.from([0])]);
}

async function writeTree(copy: IndexCopy): Promise<string> {
  const result = await copy.git(["write-tree"]);
  return result.stdout.toString("utf8").trim();
}

function nulRecords(output: Buffer): readonly Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
    records.push(output.subarray(start, end));
    start = end + 1;
  }
  return records;
}
