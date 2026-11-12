import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { IRawTheme } from "vscode-textmate";

/**
 * Foreground of the theme's default rule. It never reaches output: tokens drawn in it are reported as the editor's
 * default foreground (`color: null`), so the webview's own editor colour applies.
 */
export const DEFAULT_FOREGROUND_PLACEHOLDER = "#00000001";

const DEFAULT_RULE = { settings: { foreground: DEFAULT_FOREGROUND_PLACEHOLDER } };

/** A theme that leaves every token in the editor's default look. */
export const UNTHEMED: IRawTheme = { settings: [DEFAULT_RULE] };

/** One `tokenColors` entry as vscode-textmate reads it. */
interface ThemeRule {
  readonly scope: string | string[];
  readonly settings: {
    readonly foreground?: string;
    readonly background?: string;
    readonly fontStyle?: string;
  };
}

interface RuleLoadResult {
  readonly rules: readonly ThemeRule[];
  readonly problems: readonly string[];
}

export interface ThemeResolutionResult {
  readonly theme: IRawTheme;
  /** Why parts of the theme were skipped, such as an unreadable include; empty when everything loaded. */
  readonly problems: readonly string[];
}

const NO_RULES: RuleLoadResult = { rules: [], problems: [] };

/**
 * Builds the TextMate theme VS Code would use for a colour-theme file: the `include` chain first (paths relative to
 * the including file, so the including theme overrides it), then the file's own `tokenColors`, then the user's
 * `editor.tokenColorCustomizations` `textMateRules` last. Mirrors `ColorThemeData` in VS Code: rules without a scope
 * are dropped and a single default rule leads the list.
 */
export async function resolveTextMateTheme(themePath: string, customRules: readonly unknown[]): Promise<ThemeResolutionResult> {
  const themeRules = await loadThemeRules(path.resolve(themePath), []);
  const settings = [DEFAULT_RULE, ...themeRules.rules, ...parseRules(customRules)];
  return { theme: { settings }, problems: themeRules.problems };
}

async function loadThemeRules(themePath: string, includedFrom: readonly string[]): Promise<RuleLoadResult> {
  if (includedFrom.includes(themePath)) {
    return { rules: [], problems: [`Theme include cycle at ${themePath}`] };
  }
  if (isTmTheme(themePath)) {
    return { rules: [], problems: [`Theme ${themePath}: tmTheme themes are not supported`] };
  }
  const content = await readJsonc(themePath);
  if (content.problem !== null) {
    return { rules: [], problems: [content.problem] };
  }
  if (!isRecord(content.value)) {
    return { rules: [], problems: [`Theme ${themePath} is not a JSON object`] };
  }

  const include = content.value["include"];
  const included = typeof include === "string"
    ? await loadThemeRules(path.resolve(path.dirname(themePath), include), [...includedFrom, themePath])
    : NO_RULES;
  const own = await loadTokenColors(content.value["tokenColors"], themePath);
  return { rules: [...included.rules, ...own.rules], problems: [...included.problems, ...own.problems] };
}

/** `tokenColors` is either the rule array or a path, relative to the theme, to a JSON file holding it. */
async function loadTokenColors(tokenColors: unknown, themePath: string): Promise<RuleLoadResult> {
  if (tokenColors === undefined) {
    return NO_RULES;
  }
  if (Array.isArray(tokenColors)) {
    return { rules: parseRules(tokenColors), problems: [] };
  }
  if (typeof tokenColors !== "string") {
    return { rules: [], problems: [`Theme ${themePath} has an invalid tokenColors value`] };
  }

  const colorsPath = path.resolve(path.dirname(themePath), tokenColors);
  if (path.extname(colorsPath).toLowerCase() !== ".json") {
    return { rules: [], problems: [`Token colors ${colorsPath} are not JSON; .tmTheme files are not supported`] };
  }
  const content = await readJsonc(colorsPath);
  if (content.problem !== null) {
    return { rules: [], problems: [content.problem] };
  }
  const rules = isRecord(content.value) ? content.value["tokenColors"] : content.value;
  return Array.isArray(rules)
    ? { rules: parseRules(rules), problems: [] }
    : { rules: [], problems: [`Token colors ${colorsPath} hold no rule array`] };
}

function isTmTheme(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".tmtheme";
}

interface JsonReadResult {
  readonly value: unknown;
  /** Why the file could not be read or parsed; null on success. */
  readonly problem: string | null;
}

async function readJsonc(filePath: string): Promise<JsonReadResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    return { value: undefined, problem: `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
  }

  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  const firstError = errors[0];
  if (firstError !== undefined) {
    return { value: undefined, problem: `Cannot parse ${filePath}: ${printParseErrorCode(firstError.error)} at offset ${firstError.offset}` };
  }
  return { value, problem: null };
}

/** Keeps entries with a scope and settings, as VS Code does, normalising their colours. */
function parseRules(entries: readonly unknown[]): ThemeRule[] {
  return entries.flatMap((entry): ThemeRule[] => {
    if (!isRecord(entry) || !isRecord(entry["settings"]) || !isScope(entry["scope"])) {
      return [];
    }
    return [{ scope: entry["scope"], settings: parseSettings(entry["settings"]) }];
  });
}

function parseSettings(settings: Readonly<Record<string, unknown>>): ThemeRule["settings"] {
  const foreground = normalizeColor(settings["foreground"]);
  const background = normalizeColor(settings["background"]);
  const fontStyle = settings["fontStyle"];
  return {
    ...(foreground === undefined ? {} : { foreground }),
    ...(background === undefined ? {} : { background }),
    ...(typeof fontStyle === "string" ? { fontStyle } : {}),
  };
}

function isScope(value: unknown): value is string | string[] {
  const isNonEmptyString = typeof value === "string" && value !== "";
  const isScopeList = Array.isArray(value) && value.length > 0 && value.every((scope) => typeof scope === "string");
  return isNonEmptyString || isScopeList;
}

const SHORT_HEX_LENGTHS: readonly number[] = [4, 5];
const HEX_LENGTHS: readonly number[] = [4, 5, 7, 9];
const OPAQUE_ALPHA = "FF";

/**
 * `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa` to upper-case `#RRGGBB[AA]` with an opaque alpha dropped; anything else
 * is undefined. Matches `normalizeColor` in VS Code's `colorThemeData.ts`.
 */
export function normalizeColor(color: unknown): string | undefined {
  if (typeof color !== "string" || !color.startsWith("#") || !HEX_LENGTHS.includes(color.length)) {
    return undefined;
  }
  const digits = color.slice(1).toUpperCase();
  if (!/^[0-9A-F]+$/.test(digits)) {
    return undefined;
  }

  const expanded = SHORT_HEX_LENGTHS.includes(color.length) ? [...digits].map((digit) => digit + digit).join("") : digits;
  const isOpaque = expanded.length === 8 && expanded.endsWith(OPAQUE_ALPHA);
  return `#${isOpaque ? expanded.slice(0, 6) : expanded}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
