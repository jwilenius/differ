import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_TOKENIZED_LINE_LENGTH, MAX_TOKENIZED_TEXT_LENGTH, TextMateHighlighter, type GrammarContribution } from "../highlight/textMateHighlighter";
import { resolveTextMateTheme } from "../highlight/themeResolver";
import { FontStyleFlag, type HighlightedText } from "../model/syntaxTokens";

const FIXTURES = path.join(__dirname, "fixtures", "highlight");
const WASM_PATH = path.join(__dirname, "..", "..", "node_modules", "vscode-oniguruma", "release", "onig.wasm");
const GRAMMARS: readonly GrammarContribution[] = [
  { scopeName: "source.demo", path: path.join(FIXTURES, "demo.tmLanguage.json"), language: "demo" },
  { scopeName: "todo.injection", path: path.join(FIXTURES, "todo.injection.tmLanguage.json"), injectTo: ["source.demo"] },
];

type StyledRun = readonly [text: string, color: string | null, fontStyle: number];

/** Each line's runs as `[text, color, fontStyle]`, so expectations read like the source. */
function styledRuns(text: string, highlighted: HighlightedText): StyledRun[][] {
  return text.split("\n").map((line, lineIndex) => {
    let offset = 0;
    return (highlighted.lines[lineIndex] ?? []).map((token): StyledRun => {
      const style = highlighted.styles[token.styleIndex];
      const run: StyledRun = [line.slice(offset, offset + token.length), style?.color ?? null, style?.fontStyle ?? -1];
      offset += token.length;
      return run;
    });
  });
}

describe("TextMateHighlighter", () => {
  let highlighter: TextMateHighlighter;
  const problems: string[] = [];

  beforeAll(async () => {
    const customRules = [{ scope: "keyword", settings: { foreground: "#123456" } }];
    const { theme } = await resolveTextMateTheme(path.join(FIXTURES, "themes", "nested", "top.json"), customRules);
    highlighter = new TextMateHighlighter({ wasmPath: WASM_PATH, grammars: GRAMMARS, theme, onProblem: (message) => problems.push(message) });
  });

  it("colours tokens with the resolved theme, carries state across lines and applies injections", async () => {
    const text = "let x = 42 /* a TODO\r\nstill */ \"s\"\n";

    const highlighted = await highlighter.highlight(text, "source.demo");

    expect(styledRuns(text, highlighted)).toEqual([
      [
        ["let", "#123456", 0],
        [" x = ", null, 0],
        ["42", "#B5CEA8", 0],
        [" ", null, 0],
        ["/* a ", "#6A9955", FontStyleFlag.italic],
        ["TODO\r", "#FF0000", FontStyleFlag.bold],
      ],
      [
        ["still */", "#6A9955", FontStyleFlag.italic],
        [" ", null, 0],
        ["\"s\"", "#AABBCC", 0],
      ],
      [["", null, 0]],
    ]);
  });

  it("lists each distinct style once with the unstyled look first", async () => {
    const highlighted = await highlighter.highlight("let a = 1\nconst b = 2", "source.demo");

    expect(highlighted.styles).toEqual([
      { color: null, fontStyle: 0 },
      { color: "#123456", fontStyle: 0 },
      { color: "#B5CEA8", fontStyle: 0 },
    ]);
  });

  it("returns one unstyled token per line for an unknown scope", async () => {
    const highlighted = await highlighter.highlight("ab\n\ncde", "source.unknown");

    expect(highlighted).toEqual({
      styles: [{ color: null, fontStyle: 0 }],
      lines: [[{ length: 2, styleIndex: 0 }], [{ length: 0, styleIndex: 0 }], [{ length: 3, styleIndex: 0 }]],
    });
  });

  it("leaves over-long lines unstyled without breaking the following lines", async () => {
    const longLine = `let ${"x".repeat(MAX_TOKENIZED_LINE_LENGTH)}`;

    const highlighted = await highlighter.highlight(`${longLine}\nlet`, "source.demo");

    expect(highlighted.lines[0]).toEqual([{ length: longLine.length, styleIndex: 0 }]);
    expect(highlighted.styles[highlighted.lines[1]?.[0]?.styleIndex ?? 0]).toEqual({ color: "#123456", fontStyle: 0 });
  });

  it("leaves a text over the length limit unstyled", async () => {
    const text = `let\n${"x".repeat(MAX_TOKENIZED_TEXT_LENGTH)}`;

    const highlighted = await highlighter.highlight(text, "source.demo");

    expect(highlighted.styles).toEqual([{ color: null, fontStyle: 0 }]);
  });

  it("leaves every line unstyled once the deadline has passed", async () => {
    const highlighted = await highlighter.highlight("let\nlet", "source.demo", { deadline: performance.now() - 1 });

    expect(highlighted.lines).toEqual([[{ length: 3, styleIndex: 0 }], [{ length: 3, styleIndex: 0 }]]);
  });

  it("yields while tokenizing and leaves the remaining lines unstyled once aborted", async () => {
    const lineCount = 25_000;
    const text = Array.from({ length: lineCount }, () => "let x = 42 /* c */").join("\n");
    // Aborts once the event loop gets a turn after tokenizing started, which only a yield allows.
    let hasYielded = false;
    let isYieldWatched = false;
    const signal = {
      get aborted(): boolean {
        if (!isYieldWatched) {
          isYieldWatched = true;
          setImmediate(() => (hasYielded = true));
        }
        return hasYielded;
      },
    } as AbortSignal;

    const highlighted = await highlighter.highlight(text, "source.demo", { signal });

    const isStyled = (tokens: readonly { readonly styleIndex: number }[] | undefined): boolean => tokens?.some((token) => token.styleIndex !== 0) ?? false;
    expect(isStyled(highlighted.lines[0])).toBe(true);
    expect(isStyled(highlighted.lines[lineCount - 1])).toBe(false);
    expect(highlighted.lines).toHaveLength(lineCount);
  });

  it("reports a grammar file that cannot be read and returns the text unstyled", async () => {
    const broken = new TextMateHighlighter({
      wasmPath: WASM_PATH,
      grammars: [{ scopeName: "source.broken", path: path.join(FIXTURES, "missing.json") }],
      theme: { settings: [] },
      onProblem: (message) => problems.push(message),
    });

    const highlighted = await broken.highlight("x", "source.broken");

    expect(highlighted.lines).toEqual([[{ length: 1, styleIndex: 0 }]]);
    expect(problems.at(-1)).toContain("Cannot load grammar source.broken");
  });

  it("reports a grammar that keeps failing to load only once", async () => {
    const reported: string[] = [];
    const broken = new TextMateHighlighter({
      wasmPath: WASM_PATH,
      grammars: [{ scopeName: "source.broken", path: path.join(FIXTURES, "missing.json") }],
      theme: { settings: [] },
      onProblem: (message) => reported.push(message),
    });

    await broken.highlight("x", "source.broken");
    await broken.highlight("y", "source.broken");

    expect(reported).toHaveLength(1);
  });
});
