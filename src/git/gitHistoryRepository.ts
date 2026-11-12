import * as fs from "node:fs/promises";
import type { HistoryCommit, HistoryData, HistoryRef, HistoryRefKind } from "../model/historyTypes";
import { runHistoryGit } from "./historyGitCommand";
import type { HistoryGitResult } from "./historyGitCommand";

/** Full lowercase object ID: 40 hex digits for SHA-1, 64 for SHA-256. */
const FULL_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `%H %P %an %aI %s`, each terminated by NUL under `-z`, so no field is ever split on spaces or newlines. */
const COMMIT_FORMAT = "--format=%H%x00%P%x00%an%x00%aI%x00%s";
const COMMIT_FIELD_COUNT = 5;
/** Keeps user settings such as `log.showSignature` or `i18n.logOutputEncoding` from changing log output. */
const LOG_OUTPUT_OPTIONS = ["--no-show-signature", "--encoding=UTF-8"] as const;

const REF_FORMAT = "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)";
const REF_NAMESPACES: ReadonlyArray<{ readonly prefix: string; readonly kind: HistoryRefKind }> = [
  { prefix: "refs/heads/", kind: "localBranch" },
  { prefix: "refs/remotes/", kind: "remoteBranch" },
  { prefix: "refs/tags/", kind: "tag" },
];

/** One commit of an ancestry walk. */
export interface AncestryEntry {
  readonly oid: string;
  readonly parents: readonly string[];
}

/** A user-supplied revision or commit ID that does not name a commit in the repository. */
export class HistoryRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryRevisionError";
  }
}

/** Git printed something the history parser does not recognise; nothing partial is returned. */
export class HistoryOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryOutputError";
  }
}

export function isFullOid(value: string): boolean {
  return FULL_OID_PATTERN.test(value);
}

/** Read-only commit metadata, labels and revision resolution for one repository. */
export class GitHistoryRepository {
  /**
   * @param root Any directory inside the repository's working tree.
   * @param env Complete child environment for Git; the runner's read default when absent.
   */
  constructor(
    private readonly root: string,
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  /**
   * Labels and every commit reachable from them, children before parents. Tips are pinned before the log is read,
   * so refs moving meanwhile cannot mix two snapshots. An unborn repository has an empty history.
   */
  async loadHistory(signal: AbortSignal): Promise<HistoryData> {
    const refs = [...await this.readRefs(signal), ...await this.readDetachedHead(signal)];
    const tips = [...new Set(refs.map((ref) => ref.oid))];
    if (tips.length === 0) {
      return { commits: [], refs: [] };
    }

    const args = ["log", ...LOG_OUTPUT_OPTIONS, "--topo-order", "-z", COMMIT_FORMAT, "--stdin"];
    const result = await this.git(args, signal, revisionInput(tips));
    return { commits: parseCommits(result.stdout), refs };
  }

  /** Resolves a branch, tag or (possibly abbreviated) hash to the commit it names now. */
  async resolveRef(ref: string, signal: AbortSignal): Promise<HistoryCommit> {
    const revision = ref.trim();
    if (revision === "") {
      throw new HistoryRevisionError("Enter a branch, tag or commit hash.");
    }
    if (revision.startsWith("-")) {
      throw new HistoryRevisionError(`"${revision}" is not a revision.`);
    }

    const args = ["rev-parse", "--verify", "-q", "--end-of-options", `${revision}^{commit}`];
    const result = await this.git(args, signal, undefined, [0, 1]);
    const oid = result.stdout.toString("utf8").trim();
    if (result.exitCode !== 0 || !isFullOid(oid)) {
      throw new HistoryRevisionError(`"${revision}" does not name a unique commit.`);
    }

    const [commit] = await this.readCommits([oid], signal);
    return commit;
  }

  /** Metadata for the given full commit OIDs, in the same order; rejects any that are not commits here. */
  async readCommits(oids: readonly string[], signal: AbortSignal): Promise<readonly HistoryCommit[]> {
    const invalidOid = oids.find((oid) => !isFullOid(oid));
    if (invalidOid !== undefined) {
      throw new HistoryRevisionError(`"${invalidOid}" is not a full commit ID.`);
    }
    if (oids.length === 0) {
      return [];
    }

    await this.assertCommitsExist(oids, signal);
    const args = ["log", ...LOG_OUTPUT_OPTIONS, "--no-walk=unsorted", "-z", COMMIT_FORMAT, "--stdin"];
    const result = await this.git(args, signal, revisionInput(oids));
    const commitsByOid = new Map(parseCommits(result.stdout).map((commit) => [commit.oid, commit]));

    return oids.map((oid) => {
      const commit = commitsByOid.get(oid);
      if (!commit) {
        throw new HistoryOutputError(`Git log omitted commit ${oid}.`);
      }
      return commit;
    });
  }

  /** Commits whose parents were cut off by a shallow clone; Git reports them as parentless. */
  async readShallowOids(signal: AbortSignal): Promise<ReadonlySet<string>> {
    const pathResult = await this.git(["rev-parse", "--path-format=absolute", "--git-path", "shallow"], signal);
    const shallowPath = pathResult.stdout.toString("utf8").trim();

    try {
      const content = await fs.readFile(shallowPath, { encoding: "utf8", signal });
      return new Set(content.split("\n").filter((line) => line !== ""));
    } catch (error) {
      const isNotShallow = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (isNotShallow) {
        return new Set();
      }
      throw error;
    }
  }

  /** Commit OID → tree OID, read from the commits alone so tree objects are never required. */
  async readTreeOids(commitOids: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
    const args = ["log", ...LOG_OUTPUT_OPTIONS, "--no-walk=unsorted", "--format=%H %T", "--stdin"];
    const result = await this.git(args, signal, revisionInput([...new Set(commitOids)]));
    return new Map(lines(result.stdout).map((line) => {
      const [commitOid = "", treeOid = ""] = line.split(" ");
      return [commitOid, treeOid];
    }));
  }

  /**
   * Every ancestor of the given commits, including themselves, with parents listed before children. Revisions are
   * fed in the given order, which only matters for ordering unrelated commits.
   */
  async readAncestry(oids: readonly string[], signal: AbortSignal): Promise<readonly AncestryEntry[]> {
    const args = ["rev-list", "--topo-order", "--reverse", "--parents", "--stdin"];
    const result = await this.git(args, signal, revisionInput(oids));
    return lines(result.stdout).map((line) => {
      const [oid = "", ...parents] = line.split(" ");
      return { oid, parents };
    });
  }

  private async readRefs(signal: AbortSignal): Promise<readonly HistoryRef[]> {
    const namespaces = REF_NAMESPACES.map((namespace) => namespace.prefix);
    const result = await this.git(["for-each-ref", REF_FORMAT, ...namespaces], signal);
    return lines(result.stdout).flatMap((line) => {
      const ref = parseRef(line);
      return ref === null ? [] : [ref];
    });
  }

  /** `HEAD` when it points directly at a commit; an attached HEAD is already covered by its branch. */
  private async readDetachedHead(signal: AbortSignal): Promise<readonly HistoryRef[]> {
    const symbolic = await this.git(["symbolic-ref", "-q", "HEAD"], signal, undefined, [0, 1]);
    const isAttached = symbolic.exitCode === 0;
    if (isAttached) {
      return [];
    }

    const head = await this.git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], signal, undefined, [0, 1]);
    const oid = head.stdout.toString("utf8").trim();
    return head.exitCode === 0 ? [{ kind: "head", name: "HEAD", oid }] : [];
  }

  private async assertCommitsExist(oids: readonly string[], signal: AbortSignal): Promise<void> {
    const args = ["cat-file", "--batch-check=%(objectname) %(objecttype)"];
    const result = await this.git(args, signal, revisionInput(oids));
    const types = lines(result.stdout).map((line) => line.split(" ")[1]);

    const missingIndex = oids.findIndex((_oid, index) => types[index] !== "commit");
    if (missingIndex !== -1) {
      throw new HistoryRevisionError(`Commit ${oids[missingIndex]} is not in this repository.`);
    }
  }

  private git(
    args: readonly string[],
    signal: AbortSignal,
    stdin?: Uint8Array,
    allowedExitCodes?: readonly number[],
  ): Promise<HistoryGitResult> {
    return runHistoryGit({
      cwd: this.root,
      args,
      signal,
      ...(stdin === undefined ? {} : { stdin }),
      ...(this.env === undefined ? {} : { env: this.env }),
      ...(allowedExitCodes === undefined ? {} : { allowedExitCodes }),
    });
  }
}

/** One revision per line, for commands reading `--stdin` instead of arguments that could exceed OS limits. */
function revisionInput(revisions: readonly string[]): Buffer {
  return Buffer.from(revisions.map((revision) => `${revision}\n`).join(""), "utf8");
}

function lines(output: Buffer): readonly string[] {
  return output.toString("utf8").split("\n").filter((line) => line !== "");
}

/** Parses a ref record; symbolic refs and tags of non-commits are not labels. */
function parseRef(line: string): HistoryRef | null {
  const [refName, oid, type, peeledOid, peeledType, symref] = line.split("\0");
  if (refName === undefined || symref === undefined) {
    throw new HistoryOutputError(`Unexpected ref record "${line}".`);
  }
  if (symref !== "") {
    return null;
  }

  const namespace = REF_NAMESPACES.find((candidate) => refName.startsWith(candidate.prefix));
  const commitOid = labelledCommitOid(oid, type, peeledOid, peeledType);
  if (namespace === undefined || commitOid === null) {
    return null;
  }
  return { kind: namespace.kind, name: refName.slice(namespace.prefix.length), oid: commitOid };
}

/** The commit a ref labels: itself, or an annotated tag's target. Nested tags and non-commit targets have none. */
function labelledCommitOid(oid: string, type: string, peeledOid: string, peeledType: string): string | null {
  if (type === "commit") {
    return oid;
  }
  if (type === "tag" && peeledType === "commit") {
    return peeledOid;
  }
  return null;
}

/** Parses `-z` log output: fixed groups of NUL-terminated fields, so newlines in values remain content. */
function parseCommits(output: Buffer): readonly HistoryCommit[] {
  const fields = output.toString("utf8").split("\0");
  const trailing = fields.pop();
  const isWellFormed = trailing === "" && fields.length % COMMIT_FIELD_COUNT === 0;
  if (!isWellFormed) {
    throw new HistoryOutputError("Git log output does not consist of whole commit records.");
  }

  const commits: HistoryCommit[] = [];
  for (let start = 0; start < fields.length; start += COMMIT_FIELD_COUNT) {
    commits.push(parseCommit(fields.slice(start, start + COMMIT_FIELD_COUNT)));
  }
  return commits;
}

function parseCommit(fields: readonly string[]): HistoryCommit {
  const [oid = "", parentList = "", author = "", authoredDate = "", subject = ""] = fields;
  const parents = parentList === "" ? [] : parentList.split(" ");
  const isValid = isFullOid(oid) && parents.every(isFullOid) && authoredDate !== "";
  if (!isValid) {
    throw new HistoryOutputError(`Unexpected commit record for "${oid}".`);
  }
  return { oid, parents, author, authoredDate, subject };
}
