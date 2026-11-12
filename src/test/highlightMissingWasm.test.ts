import { copyFile, mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TextMateHighlighter } from "../highlight/textMateHighlighter";
import { UNTHEMED } from "../highlight/themeResolver";

// A separate file: the regex engine is loaded once per module instance, so a successful load elsewhere would mask this.
const FIXTURES = path.join(__dirname, "fixtures", "highlight");

describe("TextMateHighlighter without its regex engine", () => {
  it("does not leave the failed engine load unhandled when nothing is highlighted", async () => {
    new TextMateHighlighter({ wasmPath: path.join(FIXTURES, "missing.wasm"), grammars: [], theme: UNTHEMED });

    // Vitest fails the run on an unhandled rejection; give the failed file read time to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("falls back to unstyled text and reports the problem", async () => {
    const problems: string[] = [];
    const highlighter = new TextMateHighlighter({
      wasmPath: path.join(FIXTURES, "missing.wasm"),
      grammars: [{ scopeName: "source.demo", path: path.join(FIXTURES, "demo.tmLanguage.json") }],
      theme: UNTHEMED,
      onProblem: (message) => problems.push(message),
    });

    const highlighted = await highlighter.highlight("let a = 1;", "source.demo");

    expect(highlighted.lines).toEqual([[{ length: 10, styleIndex: 0 }]]);
    expect(problems.join("\n")).toContain("regex engine");
  });

  it("retries loading the engine on the next highlight after a failed load", async () => {
    const wasmPath = path.join(await mkdtemp(path.join(os.tmpdir(), "differ-onig-")), "onig.wasm");
    const highlighter = new TextMateHighlighter({
      wasmPath,
      grammars: [{ scopeName: "source.demo", path: path.join(FIXTURES, "demo.tmLanguage.json") }],
      theme: { settings: [{ scope: "keyword", settings: { foreground: "#123456" } }] },
    });
    const missing = await highlighter.highlight("let", "source.demo");

    await copyFile(path.join(__dirname, "..", "..", "node_modules", "vscode-oniguruma", "release", "onig.wasm"), wasmPath);
    const highlighted = await highlighter.highlight("let", "source.demo");

    expect(missing.styles).toHaveLength(1);
    expect(highlighted.styles).toContainEqual({ color: "#123456", fontStyle: 0 });
  });
});
