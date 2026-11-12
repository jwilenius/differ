import * as path from "node:path";
import * as vscode from "vscode";
import { TextMateHighlighter, unstyledText, type GrammarContribution, type HighlightOptions } from "../../highlight/textMateHighlighter";
import { UNTHEMED, resolveTextMateTheme, type ThemeResolutionResult } from "../../highlight/themeResolver";
import type { HighlightedText } from "../../model/syntaxTokens";

/** A colour theme as an extension contributes it, with its file path made absolute. */
interface ThemeContribution {
  /** How settings name the theme: its id, else its label, else its file name, as in VS Code. */
  readonly settingsId: string;
  readonly uiTheme: string | undefined;
  readonly path: string;
}

interface Contributions {
  readonly grammars: readonly GrammarContribution[];
  readonly themes: readonly ThemeContribution[];
}

interface LanguageHighlighter {
  readonly highlighter: TextMateHighlighter;
  readonly scopeByLanguage: ReadonlyMap<string, string>;
}

/** Settings whose change alters the colours; the active theme's own change event covers automatic theme switching. */
const THEME_SETTINGS: readonly string[] = [
  "workbench.colorTheme",
  "workbench.preferredDarkColorTheme",
  "workbench.preferredLightColorTheme",
  "workbench.preferredHighContrastColorTheme",
  "workbench.preferredHighContrastLightColorTheme",
  "window.autoDetectColorScheme",
  "editor.tokenColorCustomizations",
];

/** How long reading the theme may take; a build that fails this way is forgotten like any failed build. */
const BUILD_TIMEOUT_MS = 2_000;

/** `editor.tokenColorCustomizations` keys that are applied, or that do not affect TextMate colours. */
const SUPPORTED_CUSTOMIZATION_KEYS: readonly string[] = ["textMateRules", "semanticHighlighting"];

const UI_THEME_KINDS: Readonly<Record<string, vscode.ColorThemeKind>> = {
  "vs": vscode.ColorThemeKind.Light,
  "vs-dark": vscode.ColorThemeKind.Dark,
  "hc-black": vscode.ColorThemeKind.HighContrast,
  "hc-light": vscode.ColorThemeKind.HighContrastLight,
};

/** Per theme kind: the setting VS Code reads when it picks the theme automatically, and that setting's default. */
const PREFERRED_THEMES: Readonly<Partial<Record<vscode.ColorThemeKind, readonly [setting: string, fallback: string]>>> = {
  [vscode.ColorThemeKind.Light]: ["preferredLightColorTheme", "Default Light Modern"],
  [vscode.ColorThemeKind.Dark]: ["preferredDarkColorTheme", "Default Dark Modern"],
  [vscode.ColorThemeKind.HighContrast]: ["preferredHighContrastColorTheme", "Default High Contrast"],
  [vscode.ColorThemeKind.HighContrastLight]: ["preferredHighContrastLightColorTheme", "Default High Contrast Light"],
};

/**
 * Highlights text the way VS Code's editor would: grammars contributed by installed extensions and the active colour
 * theme with the user's `editor.tokenColorCustomizations` `textMateRules`. The engine is rebuilt lazily after any of them changes.
 */
export class SyntaxHighlighting implements vscode.Disposable {
  private current: Promise<LanguageHighlighter> | null = null;
  private hasReportedUnsupportedCustomizations = false;
  private readonly subscriptions: readonly vscode.Disposable[];

  /** `wasmPath` is the bundled `onig.wasm`; `onProblem` receives why a theme or grammar could not be used. */
  constructor(
    private readonly wasmPath: string,
    private readonly onProblem: (message: string) => void = () => undefined,
    private readonly buildTimeoutMs = BUILD_TIMEOUT_MS,
  ) {
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (THEME_SETTINGS.some((setting) => event.affectsConfiguration(setting))) {
          this.invalidate();
        }
      }),
      vscode.extensions.onDidChange(() => this.invalidate()),
      vscode.window.onDidChangeActiveColorTheme(() => this.invalidate()),
    ];
  }

  /** Tokens for every line of `text` in the language VS Code assigned, unstyled when no grammar is contributed for it. */
  async highlight(text: string, languageId: string, options: HighlightOptions = {}): Promise<HighlightedText> {
    const { highlighter, scopeByLanguage } = await this.languageHighlighter();
    const scopeName = scopeByLanguage.get(languageId);
    return scopeName === undefined ? unstyledText(text) : highlighter.highlight(text, scopeName, options);
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.invalidate();
  }

  private invalidate(): void {
    this.current = null;
  }

  /** The cached engine, built on first use; a failed or hung build is forgotten so the next call retries. */
  private languageHighlighter(): Promise<LanguageHighlighter> {
    if (this.current !== null) {
      return this.current;
    }
    const build = withTimeout(this.build(), this.buildTimeoutMs, "Loading the colour theme timed out.");
    this.current = build;
    build.catch(() => {
      if (this.current === build) {
        this.invalidate();
      }
    });
    return build;
  }

  private async build(): Promise<LanguageHighlighter> {
    const { grammars, themes } = collectContributions(vscode.extensions.all);
    const theme = activeTheme(themes);
    if (theme === null) {
      this.onProblem("The active colour theme was not found among installed extensions.");
    }

    this.reportUnsupportedCustomizations();
    const resolved = await resolveTheme(theme);
    resolved.problems.forEach((problem) => this.onProblem(problem));

    const highlighter = new TextMateHighlighter({ wasmPath: this.wasmPath, grammars, theme: resolved.theme, onProblem: this.onProblem });
    return { highlighter, scopeByLanguage: scopesByLanguage(grammars) };
  }

  /** Once per session: only `textMateRules` customizations are applied, not `comments`, `strings` and the like. */
  private reportUnsupportedCustomizations(): void {
    if (this.hasReportedUnsupportedCustomizations) {
      return;
    }
    const unsupported = unsupportedCustomizationKeys();
    if (unsupported.length === 0) {
      return;
    }
    this.hasReportedUnsupportedCustomizations = true;
    this.onProblem(`editor.tokenColorCustomizations: only textMateRules are supported; ignoring ${unsupported.join(", ")}.`);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function resolveTheme(theme: ThemeContribution | null): Promise<ThemeResolutionResult> {
  if (theme === null) {
    return { theme: UNTHEMED, problems: [] };
  }
  return resolveTextMateTheme(theme.path, textMateCustomizations(theme.settingsId));
}

function collectContributions(extensions: readonly vscode.Extension<unknown>[]): Contributions {
  const grammars = extensions.flatMap((extension) => contributed(extension, "grammars").flatMap((entry) => toGrammar(entry, extension.extensionPath)));
  const themes = extensions.flatMap((extension) => contributed(extension, "themes").flatMap((entry) => toTheme(entry, extension.extensionPath)));
  return { grammars, themes };
}

/** `packageJSON.contributes[point]` entries that are objects; manifests are untrusted input. */
function contributed(extension: vscode.Extension<unknown>, point: string): readonly Readonly<Record<string, unknown>>[] {
  const manifest: unknown = extension.packageJSON;
  const contributes = isRecord(manifest) ? manifest["contributes"] : undefined;
  const entries = isRecord(contributes) ? contributes[point] : undefined;
  return Array.isArray(entries) ? entries.filter(isRecord) : [];
}

function toGrammar(entry: Readonly<Record<string, unknown>>, extensionPath: string): GrammarContribution[] {
  const { scopeName, path: grammarPath, language, injectTo } = entry;
  if (typeof scopeName !== "string" || typeof grammarPath !== "string") {
    return [];
  }
  return [{
    scopeName,
    path: path.join(extensionPath, grammarPath),
    ...(typeof language === "string" ? { language } : {}),
    ...(Array.isArray(injectTo) ? { injectTo: injectTo.filter((scope): scope is string => typeof scope === "string") } : {}),
  }];
}

function toTheme(entry: Readonly<Record<string, unknown>>, extensionPath: string): ThemeContribution[] {
  const { id, label, uiTheme, path: themePath } = entry;
  if (typeof themePath !== "string") {
    return [];
  }
  const settingsId = asString(id) ?? asString(label) ?? path.basename(themePath);
  return [{ settingsId, uiTheme: asString(uiTheme), path: path.join(extensionPath, themePath) }];
}

/** Later contributions win, so a user extension can replace a built-in grammar, as in VS Code. */
function scopesByLanguage(grammars: readonly GrammarContribution[]): ReadonlyMap<string, string> {
  return new Map(grammars.flatMap((grammar) => (grammar.language === undefined ? [] : [[grammar.language, grammar.scopeName] as const])));
}

/**
 * The theme named by `workbench.colorTheme`, unless VS Code picks the theme from the system: with
 * `window.autoDetectColorScheme` on, or when the active theme's kind differs from the configured one (as
 * `window.autoDetectHighContrast` does), the preferred theme for the active kind is in use instead.
 */
function activeTheme(themes: readonly ThemeContribution[]): ThemeContribution | null {
  const workbench = vscode.workspace.getConfiguration("workbench");
  const kind = vscode.window.activeColorTheme.kind;
  const configured = findTheme(themes, workbench.get<string>("colorTheme"));
  const isAutoDetected = vscode.workspace.getConfiguration("window").get<boolean>("autoDetectColorScheme") === true;
  const isConfiguredActive = configured !== null && UI_THEME_KINDS[configured.uiTheme ?? ""] === kind;
  if (isConfiguredActive && !isAutoDetected) {
    return configured;
  }

  const preferred = PREFERRED_THEMES[kind];
  if (preferred === undefined) {
    return configured;
  }
  const [preferredSetting, fallbackTheme] = preferred;
  return findTheme(themes, workbench.get<string>(preferredSetting)) ?? findTheme(themes, fallbackTheme) ?? configured;
}

function findTheme(themes: readonly ThemeContribution[], settingsId: string | undefined): ThemeContribution | null {
  return themes.find((theme) => theme.settingsId === settingsId) ?? null;
}

/**
 * Global `textMateRules` first, then those under `[<theme settings id>]`, so the theme-specific rules win. The other
 * customization keys (`comments`, `strings`, …, multi-theme and wildcard keys) are not supported.
 */
function textMateCustomizations(themeSettingsId: string): readonly unknown[] {
  const customizations = tokenColorCustomizations();
  if (customizations === null) {
    return [];
  }
  return [customizations, customizations[`[${themeSettingsId}]`]].flatMap(textMateRulesOf);
}

/** Customization keys other than `textMateRules`, at the top level and inside `[<theme>]` sections. */
function unsupportedCustomizationKeys(): readonly string[] {
  const customizations = tokenColorCustomizations();
  if (customizations === null) {
    return [];
  }
  const isThemeSection = (key: string): boolean => key.startsWith("[") && key.endsWith("]");
  const sections = [customizations, ...Object.keys(customizations).filter(isThemeSection).map((key) => customizations[key])];
  const keys = sections.flatMap((section) => (isRecord(section) ? Object.keys(section) : []));
  return [...new Set(keys)].filter((key) => !isThemeSection(key) && !SUPPORTED_CUSTOMIZATION_KEYS.includes(key));
}

function tokenColorCustomizations(): Readonly<Record<string, unknown>> | null {
  const customizations = vscode.workspace.getConfiguration("editor").get<unknown>("tokenColorCustomizations");
  return isRecord(customizations) ? customizations : null;
}

function textMateRulesOf(customization: unknown): readonly unknown[] {
  const rules = isRecord(customization) ? customization["textMateRules"] : undefined;
  return Array.isArray(rules) ? rules : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
