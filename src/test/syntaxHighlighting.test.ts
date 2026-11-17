import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyntaxHighlighting } from "../host/vscode/syntaxHighlighting";
import type { HighlightedText } from "../model/syntaxTokens";
import {
  ColorThemeKind,
  changeColorThemeKind,
  changeConfiguration,
  changeExtensions,
  resetVscodeMock,
  vscodeMock,
  type FakeExtension,
} from "./vscodeMock";

const FIXTURES = path.join(__dirname, "fixtures", "highlight");
const WASM_PATH = path.join(__dirname, "..", "..", "node_modules", "vscode-oniguruma", "release", "onig.wasm");
const DEFAULT_THEMES_DIRECTORY = path.join(__dirname, "..", "..", "media", "themes");
const DEFAULT_GRAMMARS_DIRECTORY = path.join(__dirname, "..", "..", "media", "grammars");

const GRAMMAR_EXTENSION: FakeExtension = {
  id: "test.demo-language",
  extensionPath: FIXTURES,
  packageJSON: {
    contributes: {
      grammars: [
        { language: "demo", scopeName: "source.demo", path: "./demo.tmLanguage.json" },
        { scopeName: "todo.injection", path: "./todo.injection.tmLanguage.json", injectTo: ["source.demo"] },
      ],
    },
  },
};

const THEME_EXTENSION: FakeExtension = {
  id: "test.themes",
  extensionPath: path.join(FIXTURES, "themes"),
  packageJSON: {
    contributes: {
      themes: [
        { id: "Top Theme", label: "Top", uiTheme: "vs-dark", path: "./nested/top.json" },
        { id: "Default Light Modern", label: "Light Modern", uiTheme: "vs", path: "./base.json" },
        { label: "Dark Alt", uiTheme: "vs-dark", path: "./base.json" },
      ],
    },
  },
};

/** A built-in theme under the id newer VS Code gave it; VS Code 1.90 contributes it as "Default Light Modern". */
const RENAMED_THEME_EXTENSION: FakeExtension = {
  id: "test.renamed-theme",
  extensionPath: path.join(FIXTURES, "themes"),
  packageJSON: { contributes: { themes: [{ id: "Light Modern", uiTheme: "vs", path: "./base.json" }] } },
};

/** Colour of the first token on each line. */
function firstColors(highlighted: HighlightedText): (string | null)[] {
  return highlighted.lines.map((tokens) => highlighted.styles[tokens[0]?.styleIndex ?? 0]?.color ?? null);
}

describe("SyntaxHighlighting", () => {
  let highlighting: SyntaxHighlighting;
  let problems: string[];

  beforeEach(() => {
    resetVscodeMock();
    vscodeMock.extensions = [GRAMMAR_EXTENSION, THEME_EXTENSION];
    vscodeMock.configuration.set("workbench.colorTheme", "Top Theme");
    problems = [];
    highlighting = new SyntaxHighlighting(WASM_PATH, DEFAULT_THEMES_DIRECTORY, DEFAULT_GRAMMARS_DIRECTORY, (message) => problems.push(message));
  });

  afterEach(() => highlighting.dispose());

  it("uses the configured theme with global and theme-specific textMate customizations", async () => {
    vscodeMock.configuration.set("editor.tokenColorCustomizations", {
      textMateRules: [{ scope: "keyword", settings: { foreground: "#111111" } }, { scope: "string", settings: { foreground: "#333333" } }],
      "[Top Theme]": { textMateRules: [{ scope: "keyword", settings: { foreground: "#222222" } }] },
      "[Other]": { textMateRules: [{ scope: "constant", settings: { foreground: "#444444" } }] },
    });

    const highlighted = await highlighting.highlight("let\n42\n\"s\"", "demo");

    expect(firstColors(highlighted)).toEqual(["#222222", "#B5CEA8", "#333333"]);
    expect(problems).toEqual([]);
  });

  it("returns unstyled lines for a language without a grammar", async () => {
    const highlighted = await highlighting.highlight("let\nx", "plaintext");

    expect(highlighted).toEqual({ styles: [{ color: null, fontStyle: 0 }], lines: [[{ length: 3, styleIndex: 0 }], [{ length: 1, styleIndex: 0 }]] });
  });

  it("uses the default theme for the active kind when the configured theme is of another kind", async () => {
    vscodeMock.colorThemeKind = ColorThemeKind.Light;

    const highlighted = await highlighting.highlight("let\n42", "demo");

    expect(firstColors(highlighted)).toEqual(["#569CD6", null]);
  });

  it("uses the preferred theme for the active kind when the colour scheme is detected automatically", async () => {
    vscodeMock.configuration.set("window.autoDetectColorScheme", true);
    vscodeMock.configuration.set("workbench.preferredDarkColorTheme", "Dark Alt");

    const highlighted = await highlighting.highlight("let\n42", "demo");

    expect(firstColors(highlighted)).toEqual(["#569CD6", null]);
  });

  it("finds a built-in theme by its old id after VS Code renamed it, with customizations under the new id", async () => {
    vscodeMock.extensions = [GRAMMAR_EXTENSION, RENAMED_THEME_EXTENSION];
    vscodeMock.colorThemeKind = ColorThemeKind.Light;
    vscodeMock.configuration.set("workbench.colorTheme", "Default Light Modern");
    vscodeMock.configuration.set("editor.tokenColorCustomizations", {
      "[Light Modern]": { textMateRules: [{ scope: "string", settings: { foreground: "#123456" } }] },
    });

    const highlighted = await highlighting.highlight("let\n\"s\"", "demo");

    expect(firstColors(highlighted)).toEqual(["#569CD6", "#123456"]);
    expect(problems).toEqual([]);
  });

  it("falls back to the default theme for the active kind under its renamed id", async () => {
    vscodeMock.extensions = [GRAMMAR_EXTENSION, RENAMED_THEME_EXTENSION];
    vscodeMock.colorThemeKind = ColorThemeKind.Light;

    const highlighted = await highlighting.highlight("let", "demo");

    expect(firstColors(highlighted)).toEqual(["#569CD6"]);
    expect(problems).toEqual([]);
  });

  describe("when the colour theme is not installed", () => {
    const LOCAL_MESSAGE = "jw-differ shows code in VS Code's default colours: the colour theme 'Missing Theme' was not found among installed extensions.";
    const REMOTE_MESSAGE = "jw-differ shows code in VS Code's default colours: the colour theme 'Missing Theme' is not available on the remote.";

    beforeEach(() => {
      vscodeMock.extensions = [GRAMMAR_EXTENSION];
      vscodeMock.configuration.set("workbench.colorTheme", "Missing Theme");
    });

    it("warns and logs that it uses VS Code's default theme for the active kind, and applies it", async () => {
      // Dark Modern: keyword.control from Dark+, strings from Dark (Visual Studio).
      const highlighted = await highlighting.highlight("let\n\"s\"", "demo");

      expect(firstColors(highlighted)).toEqual(["#C586C0", "#CE9178"]);
      expect(vscodeMock.messages).toEqual([{ level: "warning", text: LOCAL_MESSAGE }]);
      expect(problems).toEqual([LOCAL_MESSAGE]);
    });

    it("says the theme is not available on the remote in a remote window", async () => {
      vscodeMock.remoteName = "ssh-remote";

      await highlighting.highlight("let", "demo");

      expect(vscodeMock.messages).toEqual([{ level: "warning", text: REMOTE_MESSAGE }]);
      expect(problems).toEqual([REMOTE_MESSAGE]);
    });

    it("uses the default theme of the active high contrast kind", async () => {
      vscodeMock.colorThemeKind = ColorThemeKind.HighContrastLight;

      const highlighted = await highlighting.highlight("42", "demo");

      expect(firstColors(highlighted)).toEqual(["#096D48"]);
    });

    it("uses the bundled theme the preferred theme setting names when the colour scheme is detected automatically", async () => {
      vscodeMock.configuration.set("window.autoDetectColorScheme", true);
      vscodeMock.configuration.set("workbench.preferredDarkColorTheme", "Dark 2026");

      const highlighted = await highlighting.highlight("\"s\"", "demo");

      expect(firstColors(highlighted)).toEqual(["#A5D6FF"]);
      expect(vscodeMock.messages).toEqual([]);
    });

    it("names the preferred theme for the active kind when VS Code switches to high contrast", async () => {
      vscodeMock.remoteName = "ssh-remote";
      vscodeMock.extensions = [GRAMMAR_EXTENSION, THEME_EXTENSION];
      vscodeMock.colorThemeKind = ColorThemeKind.HighContrast;
      vscodeMock.configuration.set("workbench.colorTheme", "Top Theme");
      vscodeMock.configuration.set("workbench.preferredHighContrastColorTheme", "Missing HC");

      const highlighted = await highlighting.highlight("42", "demo");

      expect(firstColors(highlighted)).toEqual(["#B5CEA8"]);
      expect(vscodeMock.messages.map((message) => message.text)).toEqual([
        "jw-differ shows code in VS Code's default colours: the colour theme 'Missing HC' is not available on the remote.",
      ]);
    });

    it("names the preferred theme for the active kind when the colour scheme is detected automatically", async () => {
      vscodeMock.configuration.set("window.autoDetectColorScheme", true);
      vscodeMock.configuration.set("workbench.preferredDarkColorTheme", "Missing Dark");

      await highlighting.highlight("let", "demo");

      expect(vscodeMock.messages.map((message) => message.text)).toEqual([
        "jw-differ shows code in VS Code's default colours: the colour theme 'Missing Dark' was not found among installed extensions.",
      ]);
    });

    it("tells once per theme across rebuilds, and again for another missing theme", async () => {
      await highlighting.highlight("let", "demo");
      changeColorThemeKind(ColorThemeKind.Light);
      await highlighting.highlight("let", "demo");
      changeConfiguration("workbench.colorTheme", "Other Missing");
      await highlighting.highlight("let", "demo");
      changeConfiguration("workbench.colorTheme", "Missing Theme");
      await highlighting.highlight("let", "demo");

      expect(vscodeMock.messages.map((message) => message.text)).toEqual([
        LOCAL_MESSAGE,
        "jw-differ shows code in VS Code's default colours: the colour theme 'Other Missing' was not found among installed extensions.",
      ]);
      expect(problems).toHaveLength(2);
    });

    it("shows code without colours, and says so, when the active theme kind has no default theme", async () => {
      vscodeMock.colorThemeKind = 99 as ColorThemeKind;

      const highlighted = await highlighting.highlight("let", "demo");

      expect(firstColors(highlighted)).toEqual([null]);
      expect(vscodeMock.messages.map((message) => message.text)).toEqual([
        "jw-differ shows code without syntax colours: the colour theme 'Missing Theme' was not found among installed extensions.",
      ]);
    });
  });

  describe("bundled VS Code default themes", () => {
    beforeEach(() => {
      vscodeMock.extensions = [GRAMMAR_EXTENSION];
    });

    it.each([
      ["Light 2026", ColorThemeKind.Light],
      ["Dark 2026", ColorThemeKind.Dark],
      ["Dark+", ColorThemeKind.Dark],
      ["Dark Modern", ColorThemeKind.Dark],
      ["Light+", ColorThemeKind.Light],
      ["Light Modern", ColorThemeKind.Light],
      ["Visual Studio Dark", ColorThemeKind.Dark],
      ["Visual Studio Light", ColorThemeKind.Light],
      ["Default High Contrast", ColorThemeKind.HighContrast],
      ["Default High Contrast Light", ColorThemeKind.HighContrastLight],
    ])("resolve '%s' with its includes and without a notification", async (themeId, kind) => {
      vscodeMock.colorThemeKind = kind;
      vscodeMock.configuration.set("workbench.colorTheme", themeId);

      const highlighted = await highlighting.highlight("\"s\"", "demo");

      expect(firstColors(highlighted)[0]).toMatch(/^#[0-9A-F]{6}$/);
      expect(problems).toEqual([]);
      expect(vscodeMock.messages).toEqual([]);
    });

    it("resolve a theme id older VS Code versions use", async () => {
      vscodeMock.configuration.set("workbench.colorTheme", "Default Dark Modern");

      const highlighted = await highlighting.highlight("let", "demo");

      expect(firstColors(highlighted)).toEqual(["#C586C0"]);
      expect(vscodeMock.messages).toEqual([]);
    });

    it("give way to an installed theme with the same id", async () => {
      const installedTheme: FakeExtension = {
        id: "test.dark-2026",
        extensionPath: path.join(FIXTURES, "themes"),
        packageJSON: { contributes: { themes: [{ id: "Dark 2026", uiTheme: "vs-dark", path: "./base.json" }] } },
      };
      vscodeMock.extensions = [GRAMMAR_EXTENSION, installedTheme];
      vscodeMock.configuration.set("workbench.colorTheme", "Dark 2026");

      const highlighted = await highlighting.highlight("let", "demo");

      expect(firstColors(highlighted)).toEqual(["#569CD6"]);
    });
  });

  it("shows no notification when the theme is found", async () => {
    await highlighting.highlight("let", "demo");

    expect(vscodeMock.messages).toEqual([]);
  });

  it("logs once per language that has neither an installed nor a default grammar, without a notification", async () => {
    vscodeMock.remoteName = "ssh-remote";

    await highlighting.highlight("fun", "kotlin");
    await highlighting.highlight("x", "plaintext");
    await highlighting.highlight("fn", "rust");
    changeExtensions([GRAMMAR_EXTENSION, THEME_EXTENSION]);
    await highlighting.highlight("fun", "kotlin");

    expect(problems).toEqual([
      "No grammar for language 'kotlin' among installed extensions on the remote or VS Code's default grammars; showing it without syntax colours.",
    ]);
    expect(vscodeMock.messages).toEqual([]);
  });

  describe("bundled VS Code default grammars", () => {
    /** Marks every token with the colour of the root scope its grammar gives it. */
    const ROOT_SCOPE_RULES = [
      { scope: "source.ts", settings: { foreground: "#111111" } },
      { scope: "source.demo", settings: { foreground: "#222222" } },
      { scope: "keyword.installed", settings: { foreground: "#333333" } },
    ];

    beforeEach(() => {
      vscodeMock.configuration.set("editor.tokenColorCustomizations", { textMateRules: ROOT_SCOPE_RULES });
    });

    it("colour a language no installed extension has a grammar for", async () => {
      const highlighted = await highlighting.highlight("let", "typescript");

      expect(firstColors(highlighted)).toEqual(["#111111"]);
      expect(problems).toEqual([]);
    });

    it("give way to an installed grammar for the same language", async () => {
      const installedTypeScript: FakeExtension = {
        id: "test.typescript-language",
        extensionPath: FIXTURES,
        packageJSON: { contributes: { grammars: [{ language: "typescript", scopeName: "source.demo", path: "./demo.tmLanguage.json" }] } },
      };
      vscodeMock.extensions = [GRAMMAR_EXTENSION, THEME_EXTENSION, installedTypeScript];

      const highlighted = await highlighting.highlight("x", "typescript");

      expect(firstColors(highlighted)).toEqual(["#222222"]);
    });

    it("give way to an installed grammar with the same scope", async () => {
      const installedScope: FakeExtension = {
        id: "test.typescript-grammar",
        extensionPath: FIXTURES,
        packageJSON: { contributes: { grammars: [{ scopeName: "source.ts", path: "./installed-typescript.tmLanguage.json" }] } },
      };
      vscodeMock.extensions = [GRAMMAR_EXTENSION, THEME_EXTENSION, installedScope];

      const highlighted = await highlighting.highlight("let", "typescript");

      expect(firstColors(highlighted)).toEqual(["#333333"]);
    });

    it("give way to an installed injection grammar with the same scope", async () => {
      const installedInjection: FakeExtension = {
        id: "test.jsdoc-injection",
        extensionPath: FIXTURES,
        packageJSON: {
          contributes: {
            grammars: [{ scopeName: "documentation.injection.ts", path: "./installed-jsdoc.injection.tmLanguage.json", injectTo: ["source.ts"] }],
          },
        },
      };
      vscodeMock.extensions = [GRAMMAR_EXTENSION, THEME_EXTENSION, installedInjection];

      const highlighted = await highlighting.highlight("/** @param x */", "typescript");

      const colors = highlighted.lines[0].map((token) => highlighted.styles[token.styleIndex]?.color);
      expect(colors).toContain("#333333");
    });

    it("colour code a default grammar embeds from another default grammar", async () => {
      // Only the TypeScript grammar scopes `let` so; markdown includes it without adding its root scope.
      vscodeMock.configuration.set("editor.tokenColorCustomizations", { textMateRules: [{ scope: "storage.type.ts", settings: { foreground: "#444444" } }] });

      const highlighted = await highlighting.highlight("```ts\nlet x = 1;\n```", "markdown");

      const embeddedLineColors = highlighted.lines[1].map((token) => highlighted.styles[token.styleIndex]?.color);
      expect(embeddedLineColors).toContain("#444444");
      expect(problems).toEqual([]);
    });
  });

  it("rebuilds after customizations, the colour theme or the installed extensions change", async () => {
    expect(firstColors(await highlighting.highlight("let", "demo"))).toEqual(["#569CD6"]);

    changeConfiguration("editor.tokenColorCustomizations", { textMateRules: [{ scope: "keyword", settings: { foreground: "#ABCDEF" } }] });
    expect(firstColors(await highlighting.highlight("let", "demo"))).toEqual(["#ABCDEF"]);

    vscodeMock.configuration.delete("editor.tokenColorCustomizations");
    changeColorThemeKind(ColorThemeKind.Light);
    expect(firstColors(await highlighting.highlight("42", "demo"))).toEqual([null]);

    changeExtensions([THEME_EXTENSION]);
    expect((await highlighting.highlight("let", "demo")).styles).toEqual([{ color: null, fontStyle: 0 }]);
  });

  it("retries building after a failed build instead of keeping the failure", async () => {
    let isBroken = true;
    const flakyExtension: FakeExtension = {
      ...GRAMMAR_EXTENSION,
      get packageJSON(): unknown {
        if (isBroken) {
          throw new Error("manifest unreadable");
        }
        return GRAMMAR_EXTENSION.packageJSON;
      },
    };
    vscodeMock.extensions = [flakyExtension, THEME_EXTENSION];

    await expect(highlighting.highlight("let", "demo")).rejects.toThrow("manifest unreadable");
    isBroken = false;

    expect(firstColors(await highlighting.highlight("let", "demo"))).toEqual(["#569CD6"]);
  });

  it("uses the configured theme when the active theme kind is unknown", async () => {
    changeColorThemeKind(99 as ColorThemeKind);

    const highlighted = await highlighting.highlight("let", "demo");

    expect(firstColors(highlighted)).toEqual(["#569CD6"]);
  });

  it("reports unsupported token colour customizations once", async () => {
    vscodeMock.configuration.set("editor.tokenColorCustomizations", {
      comments: "#00ff00",
      semanticHighlighting: true,
      textMateRules: [],
      "[Top Theme]": { textMateRules: [], keywords: "#ff0000" },
    });

    await highlighting.highlight("let", "demo");
    changeConfiguration("editor.tokenColorCustomizations", { comments: "#00ff00", strings: "#0000ff" });
    await highlighting.highlight("let", "demo");

    expect(problems).toEqual(["editor.tokenColorCustomizations: only textMateRules are supported; ignoring comments, keywords."]);
  });

  it("gives up on a theme file that never finishes reading and retries on the next highlight", async () => {
    // Reading a FIFO without a writer blocks until one opens it.
    const directory = mkdtempSync(path.join(os.tmpdir(), "jw-differ-theme-"));
    const fifo = path.join(directory, "hung.json");
    execFileSync("mkfifo", [fifo]);
    const hungTheme: FakeExtension = {
      id: "test.hung-theme",
      extensionPath: directory,
      packageJSON: { contributes: { themes: [{ id: "Hung", uiTheme: "vs-dark", path: "./hung.json" }] } },
    };
    vscodeMock.extensions = [GRAMMAR_EXTENSION, hungTheme, THEME_EXTENSION];
    vscodeMock.configuration.set("workbench.colorTheme", "Hung");
    const timed = new SyntaxHighlighting(WASM_PATH, DEFAULT_THEMES_DIRECTORY, DEFAULT_GRAMMARS_DIRECTORY, (message) => problems.push(message), 50);

    try {
      await expect(timed.highlight("let", "demo")).rejects.toThrow("timed out");
      vscodeMock.configuration.set("workbench.colorTheme", "Top Theme");
      expect(firstColors(await timed.highlight("let", "demo"))).toEqual(["#569CD6"]);
    } finally {
      timed.dispose();
      // Unblocks the pending read so it does not hold a thread-pool worker.
      writeFileSync(fifo, "{}");
    }
  });
});
