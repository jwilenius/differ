import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { candidateDirectories, discoverRepositoryRoots, findGitRepositoryRoot } from "../host/vscode/historyRepositoryDiscovery";
import { createHistoryRepository, disposeHistoryRepository } from "./gitHistoryFixture";
import { resetVscodeMock, vscodeMock } from "./vscodeMock";

describe("candidateDirectories", () => {
  beforeEach(() => resetVscodeMock());

  it("lists the active editor's directory first, then local workspace folders", () => {
    vscodeMock.activeTextEditor = { document: { uri: vscode.Uri.file("/work/editor/src/a.ts") } } as vscode.TextEditor;
    vscodeMock.workspaceFolders = [
      { uri: vscode.Uri.file("/work/alpha"), name: "alpha", index: 0 },
      { uri: vscode.Uri.parse("vscode-remote://host/work/remote"), name: "remote", index: 1 },
    ];

    expect(candidateDirectories()).toEqual(["/work/editor/src", "/work/alpha"]);
  });
});

describe("discoverRepositoryRoots", () => {
  it("returns distinct roots in order and reports failed lookups", async () => {
    const roots: Readonly<Record<string, string | null>> = { "/a/x": "/a", "/a/y": "/a", "/b": "/b", "/none": null };
    const failures: string[] = [];
    const findRoot = (directory: string): Promise<string | null> => directory === "/broken"
      ? Promise.reject(new Error("Git executable was not found."))
      : Promise.resolve(roots[directory] ?? null);

    const result = await discoverRepositoryRoots(["/a/x", "/broken", "/none", "/b", "/a/y"], findRoot, (directory) => failures.push(directory));

    expect(result).toEqual({ roots: ["/a", "/b"], problem: "Git executable was not found." });
    expect(failures).toEqual(["/broken"]);
  });
});

describe("findGitRepositoryRoot", () => {
  it("returns the canonical work-tree root for a nested directory and null outside a repository", async () => {
    const fixture = createHistoryRepository();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "differ-outside-"));
    try {
      const nested = path.join(fixture.root, "src", "deep");
      fs.mkdirSync(nested, { recursive: true });

      expect(await findGitRepositoryRoot(nested)).toBe(fixture.root);
      expect(await findGitRepositoryRoot(outside)).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      disposeHistoryRepository(fixture);
    }
  });
});
