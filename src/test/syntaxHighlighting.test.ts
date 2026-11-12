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
    highlighting = new SyntaxHighlighting(WASM_PATH, (message) => problems.push(message));
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

  it("reports a theme that is not installed and still applies the grammar", async () => {
    vscodeMock.configuration.set("workbench.colorTheme", "Missing Theme");

    const highlighted = await highlighting.highlight("let", "demo");

    expect(firstColors(highlighted)).toEqual([null]);
    expect(problems).toEqual(["The active colour theme was not found among installed extensions."]);
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
    const directory = mkdtempSync(path.join(os.tmpdir(), "differ-theme-"));
    const fifo = path.join(directory, "hung.json");
    execFileSync("mkfifo", [fifo]);
    const hungTheme: FakeExtension = {
      id: "test.hung-theme",
      extensionPath: directory,
      packageJSON: { contributes: { themes: [{ id: "Hung", uiTheme: "vs-dark", path: "./hung.json" }] } },
    };
    vscodeMock.extensions = [GRAMMAR_EXTENSION, hungTheme, THEME_EXTENSION];
    vscodeMock.configuration.set("workbench.colorTheme", "Hung");
    const timed = new SyntaxHighlighting(WASM_PATH, (message) => problems.push(message), 50);

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
