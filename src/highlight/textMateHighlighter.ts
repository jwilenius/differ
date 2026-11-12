import { readFile } from "node:fs/promises";
import * as oniguruma from "vscode-oniguruma";
import { INITIAL, Registry, parseRawGrammar, type IGrammar, type IOnigLib, type IRawGrammar, type IRawTheme } from "vscode-textmate";
import type { HighlightedText, SyntaxToken, TokenStyle } from "../model/syntaxTokens";
import { DEFAULT_FOREGROUND_PLACEHOLDER } from "./themeResolver";

/** A grammar as an extension contributes it, with its file path made absolute. */
export interface GrammarContribution {
  readonly scopeName: string;
  /** Absolute path of the `.json` or plist grammar file. */
  readonly path: string;
  /** Language the grammar is the root grammar for; absent for injection grammars. */
  readonly language?: string;
  /** Scopes this grammar is injected into. */
  readonly injectTo?: readonly string[];
}

export interface TextMateHighlighterOptions {
  /** Path of `onig.wasm` from `vscode-oniguruma`. */
  readonly wasmPath: string;
  readonly grammars: readonly GrammarContribution[];
  readonly theme: IRawTheme;
  /** Receives why a grammar could not be loaded; the text is then returned unstyled. */
  readonly onProblem?: (message: string) => void;
}

/** VS Code's `editor.maxTokenizationLineLength` default: longer lines stay unstyled. */
export const MAX_TOKENIZED_LINE_LENGTH = 20_000;
/** Larger texts stay unstyled: the time budget could not tokenize much of them anyway. */
export const MAX_TOKENIZED_TEXT_LENGTH = 500_000;
/** Default time for tokenizing one text; lines left once it has passed stay unstyled. */
export const TOKENIZE_TIME_BUDGET_MS = 2_000;
/** Per-line budget VS Code gives `tokenizeLine2`; a line that runs over keeps its partial tokens. */
const LINE_TIME_LIMIT_MS = 500;
/** Tokenizing yields to the event loop after this much uninterrupted work, so the extension host stays responsive. */
const YIELD_INTERVAL_MS = 15;

export interface HighlightOptions {
  /** Once aborted, the remaining lines stay unstyled. */
  readonly signal?: AbortSignal;
  /** `performance.now()` time after which the remaining lines stay unstyled; lets several texts share one budget. */
  readonly deadline?: number;
}

/** A loaded grammar and the colour map its token metadata indexes into. */
interface LoadedGrammar {
  readonly grammar: IGrammar;
  readonly colorMap: readonly string[];
}

/** Bits of vscode-textmate's encoded token metadata (`EncodedTokenAttributes`). */
const FONT_STYLE_OFFSET = 11;
const FONT_STYLE_MASK = 0xf;
const FOREGROUND_OFFSET = 15;
const FOREGROUND_MASK = 0x1ff;

const UNSTYLED: TokenStyle = { color: null, fontStyle: 0 };
const UNSTYLED_INDEX = 0;

let onigLib: Promise<IOnigLib> | null = null;

/**
 * The WebAssembly regex engine is process-wide in `vscode-oniguruma`, so it is loaded once and shared. A failed read
 * of the file is forgotten so the next call retries; `vscode-oniguruma` keeps a failed compile for good.
 */
function loadOnigLib(wasmPath: string): Promise<IOnigLib> {
  onigLib ??= readFile(wasmPath)
    .then((wasm) => oniguruma.loadWASM(wasm))
    .then(
      (): IOnigLib => ({
        createOnigScanner: (sources: string[]) => oniguruma.createOnigScanner(sources),
        createOnigString: (text: string) => oniguruma.createOnigString(text),
      }),
      (error: unknown) => {
        onigLib = null;
        throw new Error(`Cannot load the regex engine ${wasmPath}: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  return onigLib;
}

/** Colours text with TextMate grammars and a theme, the way VS Code's editor tokenizer does. */
export class TextMateHighlighter {
  /** Created once the regex engine loads; a failed load is forgotten so the next highlight retries. */
  private registry: Promise<Registry> | null = null;
  private readonly grammarPaths: ReadonlyMap<string, string>;
  private readonly injections: ReadonlyMap<string, string[]>;
  private readonly reportProblem: (message: string) => void;
  /** vscode-textmate keeps a failed grammar load, so it would fail, and be reported, on every highlight. */
  private readonly reportedProblems = new Set<string>();

  constructor(private readonly options: TextMateHighlighterOptions) {
    this.grammarPaths = new Map(options.grammars.map((grammar) => [grammar.scopeName, grammar.path]));
    this.injections = injectionsByTarget(options.grammars);
    this.reportProblem = options.onProblem ?? (() => undefined);
  }

  /** Tokens for every line of `text`; one unstyled token per line when `scopeName` has no usable grammar. */
  async highlight(text: string, scopeName: string, options: HighlightOptions = {}): Promise<HighlightedText> {
    if (text.length > MAX_TOKENIZED_TEXT_LENGTH) {
      return unstyledText(text);
    }
    const loaded = await this.loadGrammar(scopeName);
    if (loaded === null) {
      return unstyledText(text);
    }
    const deadline = options.deadline ?? performance.now() + TOKENIZE_TIME_BUDGET_MS;
    return tokenize(loaded, text.split("\n"), deadline, options.signal);
  }

  private async loadGrammar(scopeName: string): Promise<LoadedGrammar | null> {
    try {
      const registry = await this.loadRegistry();
      const grammar = await registry.loadGrammar(scopeName);
      return grammar === null ? null : { grammar, colorMap: registry.getColorMap() };
    } catch (error) {
      this.reportOnce(`Cannot load grammar ${scopeName}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private reportOnce(problem: string): void {
    if (this.reportedProblems.has(problem)) {
      return;
    }
    this.reportedProblems.add(problem);
    this.reportProblem(problem);
  }

  private loadRegistry(): Promise<Registry> {
    this.registry ??= loadOnigLib(this.options.wasmPath).then(
      (onigLib) => new Registry({
        onigLib: Promise.resolve(onigLib),
        theme: this.options.theme,
        loadGrammar: (scopeName) => readGrammar(this.grammarPaths.get(scopeName)),
        getInjections: (scopeName) => this.injections.get(scopeName),
      }),
      (error: unknown) => {
        this.registry = null;
        throw error;
      },
    );
    return this.registry;
  }
}

/**
 * Tokenizes line by line, yielding to the event loop every {@link YIELD_INTERVAL_MS}. Lines reached after `deadline` or
 * once `signal` aborts stay unstyled.
 */
async function tokenize(loaded: LoadedGrammar, lines: readonly string[], deadline: number, signal: AbortSignal | undefined): Promise<HighlightedText> {
  const styles = new StyleTable(loaded.colorMap);
  const tokenLines: SyntaxToken[][] = [];
  let ruleStack = INITIAL;
  let sliceStart = performance.now();
  for (const line of lines) {
    if (performance.now() - sliceStart > YIELD_INTERVAL_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceStart = performance.now();
    }
    const content = line.endsWith("\r") ? line.slice(0, -1) : line;
    const remainingMs = deadline - performance.now();
    const isOutOfTime = remainingMs <= 0 || signal?.aborted === true;
    if (isOutOfTime || content.length > MAX_TOKENIZED_LINE_LENGTH) {
      tokenLines.push([{ length: line.length, styleIndex: UNSTYLED_INDEX }]);
      continue;
    }
    // A time limit of 0 means none to vscode-textmate, so at least 1 ms.
    const lineTimeLimit = Math.max(1, Math.min(LINE_TIME_LIMIT_MS, Math.ceil(remainingMs)));
    const result = loaded.grammar.tokenizeLine2(content, ruleStack, lineTimeLimit);
    // Like VS Code, a line that ran out of time does not carry its unfinished state into the next line.
    if (!result.stoppedEarly) {
      ruleStack = result.ruleStack;
    }
    tokenLines.push(toSyntaxTokens(result.tokens, line.length, styles));
  }
  return { styles: styles.styles, lines: tokenLines };
}

/** `[start0, metadata0, start1, metadata1, …]` to runs covering `lineLength`, merging neighbours of equal style. */
function toSyntaxTokens(encoded: Uint32Array, lineLength: number, styles: StyleTable): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const tokenCount = encoded.length / 2;
  for (let index = 0; index < tokenCount; index++) {
    const start = encoded[2 * index] ?? 0;
    const end = index + 1 < tokenCount ? encoded[2 * index + 2] ?? lineLength : lineLength;
    if (end <= start) {
      continue;
    }
    const styleIndex = styles.indexOf(encoded[2 * index + 1] ?? 0);
    const previous = tokens[tokens.length - 1];
    if (previous?.styleIndex === styleIndex) {
      tokens[tokens.length - 1] = { length: previous.length + end - start, styleIndex };
      continue;
    }
    tokens.push({ length: end - start, styleIndex });
  }
  return tokens.length === 0 ? [{ length: lineLength, styleIndex: UNSTYLED_INDEX }] : tokens;
}

/** Distinct styles in first-use order, the unstyled look first. */
class StyleTable {
  readonly styles: TokenStyle[] = [UNSTYLED];
  private readonly indexByKey = new Map<string, number>([[styleKey(UNSTYLED), UNSTYLED_INDEX]]);

  constructor(private readonly colorMap: readonly string[]) {}

  indexOf(metadata: number): number {
    const style = this.styleOf(metadata);
    const key = styleKey(style);
    const known = this.indexByKey.get(key);
    if (known !== undefined) {
      return known;
    }
    this.styles.push(style);
    this.indexByKey.set(key, this.styles.length - 1);
    return this.styles.length - 1;
  }

  private styleOf(metadata: number): TokenStyle {
    const fontStyle = (metadata >>> FONT_STYLE_OFFSET) & FONT_STYLE_MASK;
    const color = this.colorMap[(metadata >>> FOREGROUND_OFFSET) & FOREGROUND_MASK];
    const isDefaultColor = color === undefined || color === DEFAULT_FOREGROUND_PLACEHOLDER;
    return { color: isDefaultColor ? null : color, fontStyle };
  }
}

function styleKey(style: TokenStyle): string {
  return `${style.color ?? ""}|${style.fontStyle}`;
}

/** One unstyled token per line, for text without a grammar. */
export function unstyledText(text: string): HighlightedText {
  return { styles: [UNSTYLED], lines: text.split("\n").map((line) => [{ length: line.length, styleIndex: UNSTYLED_INDEX }]) };
}

async function readGrammar(grammarPath: string | undefined): Promise<IRawGrammar | null> {
  if (grammarPath === undefined) {
    return null;
  }
  return parseRawGrammar(await readFile(grammarPath, "utf8"), grammarPath);
}

function injectionsByTarget(grammars: readonly GrammarContribution[]): ReadonlyMap<string, string[]> {
  const injections = new Map<string, string[]>();
  for (const grammar of grammars) {
    for (const target of grammar.injectTo ?? []) {
      injections.set(target, [...(injections.get(target) ?? []), grammar.scopeName]);
    }
  }
  return injections;
}
