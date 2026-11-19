import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { GitExecutableLocator } from "../host/vscode/gitExecutableLocator";
import type { GitExecutableProbe } from "../host/vscode/gitExecutableLocator";
import { gitExecutableOnPath } from "./gitHistoryFixture";
import { EventEmitter, changeConfiguration, resetVscodeMock, vscodeMock } from "./vscodeMock";
import type { FakeExtension } from "./vscodeMock";

const EXTENSION_GIT = "/usr/local/bin/git";
const CONFIGURED_GIT = "/configured/bin/git";

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

describe("GitExecutableLocator's default probe", () => {
  let locator: GitExecutableLocator;

  beforeEach(() => {
    resetVscodeMock();
    locator = new GitExecutableLocator(() => undefined);
  });

  afterEach(() => {
    locator.dispose();
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
});
