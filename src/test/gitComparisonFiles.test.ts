import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPARISON_FILE_LIMIT_BYTES, readComparisonFile, readComparisonFiles } from "../git/gitComparisonFiles";
import { GitHistoryRepository } from "../git/gitHistoryRepository";
import { resolveHistoryComparison } from "../git/historyComparisonResolver";
import { replaySelection } from "../git/gitSelectionReplay";
import type { ReplaySession } from "../git/gitSelectionReplay";
import type { ComparisonFile, FileContentResult, FileSide } from "../model/historyTypes";
import {
  commitFiles,
  createHistoryRepository,
  disposeHistoryRepository,
  fixtureGitEnvironment,
  runFixtureGit,
} from "./gitHistoryFixture";
import type { FixtureFileChange, HistoryRepositoryFixture } from "./gitHistoryFixture";

const signal = new AbortController().signal;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("comparison files", () => {
  let fixture: HistoryRepositoryFixture;
  const sessions: ReplaySession[] = [];

  beforeEach(() => {
    fixture = createHistoryRepository();
  });

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.dispose()));
    disposeHistoryRepository(fixture);
  });

  function write(filePath: string, content: string | Uint8Array, isExecutable?: boolean): FixtureFileChange {
    return { kind: "write", path: filePath, content, ...(isExecutable === undefined ? {} : { isExecutable }) };
  }

  function remove(filePath: string): FixtureFileChange {
    return { kind: "delete", path: filePath };
  }

  function commit(message: string, ...changes: FixtureFileChange[]): string {
    return commitFiles(fixture.root, { message, changes });
  }

  function git(...args: string[]): string {
    return runFixtureGit(fixture.root, args).trim();
  }

  /** Replays the selected commits onto their Automatic base. */
  async function replay(...selectedOids: string[]): Promise<ReplaySession> {
    const env = fixtureGitEnvironment();
    const request = { selectedOids, base: { kind: "automatic" } as const, mainlines: [] };
    const comparison = await resolveHistoryComparison(new GitHistoryRepository(fixture.root, env), request, signal);
    if (comparison.kind !== "resolved") {
      throw new Error("Expected a resolved comparison.");
    }
    const result = await replaySelection(fixture.root, comparison, signal, { env });
    if (result.kind !== "replayed") {
      throw new Error("Expected a replayed session.");
    }
    sessions.push(result.session);
    return result.session;
  }

  /** Net files of replaying the selected commits onto their Automatic base. */
  async function filesOf(...selectedOids: string[]): Promise<readonly ComparisonFile[]> {
    return readComparisonFiles(await replay(...selectedOids), signal);
  }

  async function contentOf(session: ReplaySession, file: ComparisonFile, side: FileSide): Promise<FileContentResult> {
    return readComparisonFile(session, file, side, signal);
  }

  function fileAt(files: readonly ComparisonFile[], filePath: string): ComparisonFile {
    const file = files.find((candidate) => (candidate.result ?? candidate.base)?.path === filePath);
    if (file === undefined) {
      throw new Error(`No file row for ${filePath}.`);
    }
    return file;
  }

  it("lists additions and deletions with an empty missing side", async () => {
    commit("A", write("gone.txt", "old\n"));
    const b = commit("B", write("new.txt", "new\n"), remove("gone.txt"));
    const session = await replay(b);

    const files = await readComparisonFiles(session, signal);

    const added = fileAt(files, "new.txt");
    const deleted = fileAt(files, "gone.txt");
    expect(added).toMatchObject({ status: "added", base: null, contentKind: "text" });
    expect(added.id).toMatch(UUID_PATTERN);
    expect(deleted).toMatchObject({ status: "deleted", result: null });
    expect(await contentOf(session, added, "base")).toEqual({ kind: "text", text: "" });
    expect(await contentOf(session, added, "result")).toEqual({ kind: "text", text: "new\n" });
    expect(await contentOf(session, deleted, "base")).toEqual({ kind: "text", text: "old\n" });
    expect(await contentOf(session, deleted, "result")).toEqual({ kind: "text", text: "" });
  });

  it("reads both sides of a modification exactly, including CRLF and a missing final newline", async () => {
    commit("A", write("f.txt", "one\ntwo\n"));
    const b = commit("B", write("f.txt", "one\r\ntwo"));
    const session = await replay(b);

    const [file] = await readComparisonFiles(session, signal);

    expect(file).toMatchObject({ status: "modified", base: { path: "f.txt", mode: "100644" } });
    expect(await contentOf(session, file!, "base")).toEqual({ kind: "text", text: "one\ntwo\n" });
    expect(await contentOf(session, file!, "result")).toEqual({ kind: "text", text: "one\r\ntwo" });
  });

  it("preserves a byte order mark", async () => {
    commit("A", write("a.txt", "a\n"));
    const b = commit("B", write("bom.txt", "﻿text\n"));
    const session = await replay(b);

    const [file] = await readComparisonFiles(session, signal);

    expect(await contentOf(session, file!, "result")).toEqual({ kind: "text", text: "﻿text\n" });
  });

  it("reports a rename with its old and new paths", async () => {
    const content = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join("");
    commit("A", write("old name.txt", content));
    git("mv", "old name.txt", "new name.txt");
    const b = commit("B", write("new name.txt", `${content}extra\n`));

    const files = await filesOf(b);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      status: "renamed",
      base: { path: "old name.txt" },
      result: { path: "new name.txt" },
    });
  });

  it("keeps a rename between unusual file names intact", async () => {
    const content = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join("");
    commit("A", write("old\tname.txt", content));
    git("mv", "old\tname.txt", "new\nname.txt");
    const b = commit("B");

    const files = await filesOf(b);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      status: "renamed",
      base: { path: "old\tname.txt" },
      result: { path: "new\nname.txt" },
    });
  });

  it("reports a file replaced by a symlink as a type change", async () => {
    commit("A", write("entry", "plain file\n"));
    fs.rmSync(path.join(fixture.root, "entry"));
    fs.symlinkSync("target", path.join(fixture.root, "entry"));
    git("add", "entry");
    const b = commit("B");
    const session = await replay(b);

    const [file] = await readComparisonFiles(session, signal);

    expect(file).toMatchObject({ status: "typeChanged", base: { mode: "100644" }, result: { mode: "120000" } });
    expect(await contentOf(session, file!, "base")).toEqual({ kind: "text", text: "plain file\n" });
    expect(await contentOf(session, file!, "result")).toEqual({ kind: "text", text: "target" });
  });

  it("keeps unusual file names intact", async () => {
    const names = ["tab\tname.txt", "new\nline.txt", "-leading-dash.txt", ":colon.txt", "HEAD~1"];
    commit("A", write("a.txt", "a\n"));
    const b = commit("B", ...names.map((name) => write(name, `${name}\n`)));
    const session = await replay(b);

    const files = await readComparisonFiles(session, signal);

    expect(files.map((file) => file.result?.path).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(await contentOf(session, fileAt(files, name), "result")).toEqual({ kind: "text", text: `${name}\n` });
    }
  });

  it("describes binary content instead of decoding it", async () => {
    commit("A", write("a.txt", "a\n"));
    const b = commit("B", write("data.bin", Buffer.from([0x50, 0x00, 0xff, 0x01])));
    const session = await replay(b);

    const [file] = await readComparisonFiles(session, signal);
    const content = await contentOf(session, file!, "result");

    expect(file?.contentKind).toBe("binary");
    expect(content).toMatchObject({ kind: "nonText", reason: "binary", sizeBytes: 4, mode: "100644" });
  });

  it("describes invalid UTF-8 instead of decoding it", async () => {
    commit("A", write("a.txt", "a\n"));
    const b = commit("B", write("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])));
    const session = await replay(b);

    const [file] = await readComparisonFiles(session, signal);

    expect(await contentOf(session, file!, "result")).toMatchObject({ kind: "nonText", reason: "invalidEncoding" });
  });

  it("describes content over the size limit without loading it", async () => {
    commit("A", write("a.txt", "a\n"));
    const b = commit("B", write("big.txt", Buffer.alloc(COMPARISON_FILE_LIMIT_BYTES + 1, 0x61)));
    const session = await replay(b);

    const [file] = await readComparisonFiles(session, signal);

    expect(await contentOf(session, file!, "result")).toMatchObject({
      kind: "nonText",
      reason: "oversize",
      sizeBytes: COMPARISON_FILE_LIMIT_BYTES + 1,
    });
  });

  it("shows a symlink's target without following it", async () => {
    commit("A", write("a.txt", "a\n"));
    fs.symlinkSync("../outside/secret", path.join(fixture.root, "link"));
    git("add", "link");
    const b = commit("B");
    const session = await replay(b);

    const [file] = await readComparisonFiles(session, signal);

    expect(file?.result?.mode).toBe("120000");
    expect(await contentOf(session, file!, "result")).toEqual({ kind: "text", text: "../outside/secret" });
  });

  it("shows a gitlink's submodule commit", async () => {
    const a = commit("A", write("a.txt", "a\n"));
    git("update-index", "--add", "--cacheinfo", `160000,${a},vendor/lib`);
    const b = commit("B");
    const session = await replay(b);

    const [file] = await readComparisonFiles(session, signal);

    expect(file).toMatchObject({ status: "added", contentKind: "gitlink", result: { path: "vendor/lib", blob: a } });
    expect(await contentOf(session, file!, "result")).toEqual({ kind: "text", text: `Subproject commit ${a}\n` });
  });

  it("lists an executable-bit-only change with both modes", async () => {
    commit("A", write("run.sh", "echo\n"));
    const b = commit("B", write("run.sh", "echo\n", true));

    const [file] = await filesOf(b);

    expect(file).toMatchObject({ status: "modified", base: { mode: "100644" }, result: { mode: "100755" } });
    expect(file?.base?.blob).toBe(file?.result?.blob);
  });

  it("lists nothing when selected changes cancel out", async () => {
    commit("A", write("f.txt", "original\n"));
    const b = commit("B", write("f.txt", "changed\n"));
    const c = commit("C", write("f.txt", "original\n"));

    expect(await filesOf(b, c)).toEqual([]);
  });
});
