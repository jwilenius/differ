import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { GIT_LOOKUP_TIMEOUT_MS, GIT_PROBE_TIMEOUT_MS, GitExecutableLocator } from "../host/vscode/gitExecutableLocator";
import type { GitExecutableProbe } from "../host/vscode/gitExecutableLocator";
import { gitExecutableOnPath } from "./gitHistoryFixture";
import { EventEmitter, changeConfiguration, resetVscodeMock, vscodeMock } from "./vscodeMock";
import type { FakeExtension } from "./vscodeMock";

const EXTENSION_GIT = "/usr/local/bin/git";
const CONFIGURED_GIT = "/configured/bin/git";
/** Generous headroom over the production timeouts for tests that wait on a real child process. */
const REAL_PROCESS_TEST_TIMEOUT_MS = 2 * (GIT_PROBE_TIMEOUT_MS + GIT_LOOKUP_TIMEOUT_MS);

/** The members of the built-in Git extension's exports the locator reads. */
interface FakeGitExports {
  enabled: boolean;
  readonly enablement: EventEmitter<boolean>;
  readonly onDidChangeEnablement: EventEmitter<boolean>["event"];
  readonly getAPI: Mock<(version: number) => { readonly git: { readonly path: string } }>;
}

function gitExports(enabled = true): FakeGitExports {
  const enablement = new EventEmitter<boolean>();
  return {
    enabled,
    enablement,
    onDidChangeEnablement: enablement.event,
    getAPI: vi.fn(() => ({ git: { path: EXTENSION_GIT } })),
  };
}

function gitExtension(extension: Partial<FakeExtension>): FakeExtension {
  return { id: "vscode.git", extensionPath: "/extensions/git", packageJSON: {}, ...extension };
}

function installGitExtension(extension: Partial<FakeExtension>): void {
  vscodeMock.extensions = [gitExtension(extension)];
}

describe("GitExecutableLocator", () => {
  let lines: string[];
  let probe: Mock<GitExecutableProbe>;
  let locator: GitExecutableLocator;

  beforeEach(() => {
    resetVscodeMock();
    lines = [];
    probe = vi.fn<GitExecutableProbe>(() => Promise.resolve(true));
    locator = new GitExecutableLocator((line) => lines.push(line), probe);
  });

  afterEach(() => {
    locator.dispose();
    vi.useRealTimers();
  });

  it("uses the Git that VS Code's Git extension found without trying git.path", async () => {
    installGitExtension({ isActive: true, exports: gitExports() });
    vscodeMock.configuration.set("git.path", CONFIGURED_GIT);

    const executable = await locator.locate();

    expect(executable).toBe(EXTENSION_GIT);
    expect(probe).not.toHaveBeenCalled();
    expect(lines).toEqual([`Using Git ${EXTENSION_GIT} (found by VS Code's Git extension).`]);
  });

  it("activates the Git extension when it is not active yet", async () => {
    const exports = gitExports();
    const activate = vi.fn(() => Promise.resolve(exports));
    installGitExtension({ isActive: false, activate });

    const executable = await locator.locate();

    expect(executable).toBe(EXTENSION_GIT);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => void]>([
    ["is not installed", () => undefined],
    ["is disabled or found no Git", () => installGitExtension({ isActive: true, exports: gitExports(false) })],
    ["exports nothing", () => installGitExtension({ isActive: true, exports: undefined })],
    [
      "fails to activate",
      () => installGitExtension({ isActive: false, activate: () => Promise.reject(new Error("activation failed")) }),
    ],
    [
      "has no Git model",
      () => {
        const exports = gitExports();
        exports.getAPI.mockImplementation(() => {
          throw new Error("Git model not found");
        });
        installGitExtension({ isActive: true, exports });
      },
    ],
  ])("uses the git.path setting when the Git extension %s", async (_, arrange) => {
    arrange();
    vscodeMock.configuration.set("git.path", CONFIGURED_GIT);

    const executable = await locator.locate();

    expect(executable).toBe(CONFIGURED_GIT);
    expect(lines.at(-1)).toBe(`Using Git ${CONFIGURED_GIT} (from the "git.path" setting).`);
  });

  it("logs why the Git extension did not provide its Git", async () => {
    installGitExtension({ isActive: false, activate: () => Promise.reject(new Error("activation failed")) });

    await locator.locate();

    expect(lines[0]).toBe("VS Code's Git extension did not provide its Git: activation failed");
  });

  it("tries git.path entries in order and uses the first that runs as Git", async () => {
    vscodeMock.configuration.set("git.path", ["", 7, "/missing/git", CONFIGURED_GIT, "/later/git"]);
    probe.mockImplementation((executable) => Promise.resolve(executable === CONFIGURED_GIT));

    const executable = await locator.locate();

    expect(executable).toBe(CONFIGURED_GIT);
    expect(probe.mock.calls).toEqual([["/missing/git"], [CONFIGURED_GIT]]);
    expect(lines[0]).toBe('The "git.path" entry /missing/git does not run as Git.');
  });

  it("uses git on PATH when git.path is not set", async () => {
    const executable = await locator.locate();

    expect(executable).toBe("git");
    expect(probe).not.toHaveBeenCalled();
    expect(lines).toEqual(["Using Git git (looked up on PATH)."]);
  });

  it("uses git on PATH when no git.path entry runs as Git", async () => {
    vscodeMock.configuration.set("git.path", ["/missing/git", "/also/missing/git"]);
    probe.mockResolvedValue(false);

    const executable = await locator.locate();

    expect(executable).toBe("git");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("finds Git once for repeated requests", async () => {
    const exports = gitExports();
    installGitExtension({ isActive: true, exports });

    const executables = await Promise.all([locator.locate(), locator.locate(), locator.locate()]);

    expect(executables).toEqual([EXTENSION_GIT, EXTENSION_GIT, EXTENSION_GIT]);
    expect(exports.getAPI).toHaveBeenCalledTimes(1);
  });

  it("finds Git again when git.path changes", async () => {
    vscodeMock.configuration.set("git.path", CONFIGURED_GIT);
    await locator.locate();

    changeConfiguration("git.path", "/changed/git");

    expect(await locator.locate()).toBe("/changed/git");
  });

  it("keeps its Git when an unrelated setting changes", async () => {
    vscodeMock.configuration.set("git.path", CONFIGURED_GIT);
    await locator.locate();

    changeConfiguration("git.enabled", false);
    vscodeMock.configuration.set("git.path", "/changed/git");

    expect(await locator.locate()).toBe(CONFIGURED_GIT);
  });

  it("finds Git again when the Git extension is enabled", async () => {
    const exports = gitExports(false);
    installGitExtension({ isActive: true, exports });
    expect(await locator.locate()).toBe("git");

    exports.enabled = true;
    exports.enablement.fire(true);

    expect(await locator.locate()).toBe(EXTENSION_GIT);
  });

  it("uses git on PATH when finding Git fails unexpectedly", async () => {
    vscodeMock.configuration.set("git.path", CONFIGURED_GIT);
    probe.mockRejectedValue(new Error("probe broke"));

    const executable = await locator.locate();

    expect(executable).toBe("git");
    expect(lines).toEqual(["Using Git git (looked up on PATH, as finding Git failed: probe broke)."]);
  });

  it("does not follow enablement once disposed while the Git extension activates", async () => {
    const exports = gitExports(false);
    let finishActivation: (value: FakeGitExports) => void = () => undefined;
    const activation = new Promise<FakeGitExports>((resolve) => (finishActivation = resolve));
    installGitExtension({ isActive: false, activate: () => activation });

    const located = locator.locate();
    locator.dispose();
    finishActivation(exports);
    await located;
    exports.enabled = true;
    exports.enablement.fire(true);

    expect(await locator.locate()).toBe("git");
  });

  it("uses git on PATH while finding Git is overdue, and the found Git once it finishes", async () => {
    vi.useFakeTimers();
    let finishActivation: (value: FakeGitExports) => void = () => undefined;
    const activate = vi.fn(() => new Promise<FakeGitExports>((resolve) => (finishActivation = resolve)));
    installGitExtension({ isActive: false, activate });
    let isFirstSettled = false;

    const first = locator.locate().finally(() => (isFirstSettled = true));
    await vi.advanceTimersByTimeAsync(GIT_LOOKUP_TIMEOUT_MS - 1);
    const wasWaitingBeforeTimeout = !isFirstSettled;
    await vi.advanceTimersByTimeAsync(1);
    const overdue = await Promise.all([first, locator.locate()]);
    finishActivation(gitExports());
    await vi.waitFor(() => expect(lines.at(-1)).toMatch(/^Using Git /));
    const found = await locator.locate();

    expect(wasWaitingBeforeTimeout).toBe(true);
    expect(overdue).toEqual(["git", "git"]);
    expect(found).toBe(EXTENSION_GIT);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      `Finding Git takes over ${GIT_LOOKUP_TIMEOUT_MS} ms; using git on PATH until it finishes.`,
      `Using Git ${EXTENSION_GIT} (found by VS Code's Git extension).`,
    ]);
  });

  it("leaves no call waiting on the lookup deadline once Git is found", async () => {
    installGitExtension({ isActive: true, exports: gitExports() });
    await locator.locate();
    const race = vi.spyOn(Promise, "race");

    await Promise.all([locator.locate(), locator.locate(), locator.locate()]);
    const racers = race.mock.calls.flatMap(([values]) => Array.from(values as Iterable<Promise<unknown>>));
    race.mockRestore();

    expect(racers).toHaveLength(6);
    expect(await countPending(racers)).toBe(0);
  });

  it("stops following setting and enablement changes once disposed", async () => {
    const exports = gitExports(false);
    installGitExtension({ isActive: true, exports });
    await locator.locate();

    locator.dispose();
    exports.enabled = true;
    exports.enablement.fire(true);
    changeConfiguration("git.path", CONFIGURED_GIT);

    expect(await locator.locate()).toBe("git");
  });
});

/**
 * How many of `promises` are still pending once every queued callback has run. A pending promise keeps each reaction
 * added to it, such as those of a `Promise.race`; a settled one releases them.
 */
async function countPending(promises: readonly Promise<unknown>[]): Promise<number> {
  let settledCount = 0;
  const countSettled = (): void => {
    settledCount += 1;
  };
  for (const promise of promises) {
    void promise.then(countSettled, countSettled);
  }
  await new Promise((resolve) => setImmediate(resolve));
  return promises.length - settledCount;
}

/** Waits for `file` without timers, which a test may fake. */
async function waitForFile(file: string): Promise<void> {
  while (!fs.existsSync(file)) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("GitExecutableLocator's default probe", () => {
  let lines: string[];
  let locator: GitExecutableLocator;

  beforeEach(() => {
    resetVscodeMock();
    lines = [];
    locator = new GitExecutableLocator((line) => lines.push(line));
  });

  afterEach(() => {
    locator.dispose();
    vi.useRealTimers();
  });

  it("accepts a git.path entry that runs as Git", async () => {
    const installed = gitExecutableOnPath();
    vscodeMock.configuration.set("git.path", installed);

    expect(await locator.locate()).toBe(installed);
  });

  it("skips a git.path entry that does not exist", async () => {
    const installed = gitExecutableOnPath();
    vscodeMock.configuration.set("git.path", ["/no/such/directory/git", installed]);

    expect(await locator.locate()).toBe(installed);
  });

  it.skipIf(process.platform === "win32")(
    "kills a git.path entry that does not answer in time and tries the next",
    async () => {
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jw-differ-hanging-git-"));
      try {
        const hangingGit = path.join(folder, "git");
        const started = path.join(folder, "started");
        fs.writeFileSync(hangingGit, `#!/bin/sh\n: > '${started}'\nexec sleep 60\n`, { mode: 0o755 });
        const installed = gitExecutableOnPath();
        vscodeMock.configuration.set("git.path", [hangingGit, installed]);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        const located = locator.locate();
        await waitForFile(started);
        await vi.advanceTimersByTimeAsync(GIT_PROBE_TIMEOUT_MS);

        expect(await located).toBe(installed);
        expect(lines[0]).toBe(`The "git.path" entry ${hangingGit} does not run as Git.`);
      } finally {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});
