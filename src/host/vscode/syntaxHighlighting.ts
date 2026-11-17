import { readFile } from "node:fs/promises";
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

/** The theme the settings ask VS Code to show, and the theme jw-differ uses for it. */
interface ActiveThemeResult {
  readonly requestedId: string | undefined;
  /** The requested theme, else VS Code's default for the active kind, else the configured theme; null when none is found. */
  readonly theme: ThemeContribution | null;
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

/** VS Code languages that have no grammar by design, so a missing one is not worth reporting. */
const LANGUAGES_WITHOUT_GRAMMAR: readonly string[] = ["plaintext"];

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

/**
 * Per theme kind: the setting VS Code reads when it picks the theme automatically, and that setting's default. The
 * defaults keep the ids VS Code 1.90 contributes; {@link findTheme} maps them to the ids newer VS Code renamed them to.
 */
const PREFERRED_THEMES: Readonly<Partial<Record<vscode.ColorThemeKind, readonly [setting: string, fallback: string]>>> = {
  [vscode.ColorThemeKind.Light]: ["preferredLightColorTheme", "Default Light Modern"],
  [vscode.ColorThemeKind.Dark]: ["preferredDarkColorTheme", "Default Dark Modern"],
  [vscode.ColorThemeKind.HighContrast]: ["preferredHighContrastColorTheme", "Default High Contrast"],
  [vscode.ColorThemeKind.HighContrastLight]: ["preferredHighContrastLightColorTheme", "Default High Contrast Light"],
};

/** A theme file bundled under the default themes directory, contributed as VS Code's `theme-defaults` extension contributes it. */
interface DefaultTheme {
  readonly settingsId: string;
  readonly uiTheme: string;
  readonly file: string;
}

/**
 * VS Code's own colour themes (`theme-defaults` 1.146.0), bundled because extensions cannot reach them where the
 * workbench does not run them, as on a remote, whose server ships no themes. Installed themes take precedence.
 */
const DEFAULT_THEMES: readonly DefaultTheme[] = [
  { settingsId: "Light 2026", uiTheme: "vs", file: "2026-light.json" },
  { settingsId: "Dark 2026", uiTheme: "vs-dark", file: "2026-dark.json" },
  { settingsId: "Dark+", uiTheme: "vs-dark", file: "dark_plus.json" },
  { settingsId: "Dark Modern", uiTheme: "vs-dark", file: "dark_modern.json" },
  { settingsId: "Light+", uiTheme: "vs", file: "light_plus.json" },
  { settingsId: "Light Modern", uiTheme: "vs", file: "light_modern.json" },
  { settingsId: "Visual Studio Dark", uiTheme: "vs-dark", file: "dark_vs.json" },
  { settingsId: "Visual Studio Light", uiTheme: "vs", file: "light_vs.json" },
  { settingsId: "Default High Contrast", uiTheme: "hc-black", file: "hc_black.json" },
  { settingsId: "Default High Contrast Light", uiTheme: "hc-light", file: "hc_light.json" },
];

/**
 * The manifest of VS Code's bundled default grammars: `[{ scopeName, path, language?, injectTo? }]`, paths relative to
 * its directory, as VS Code's built-in extensions (1.146.0) without code contribute them. VS Code runs those extensions
 * in the local window, so a remote extension host does not see their grammars.
 */
const DEFAULT_GRAMMARS_MANIFEST = "grammars.json";

/**
 * Highlights text the way VS Code's editor would: grammars contributed by installed extensions and the active colour
 * theme with the user's `editor.tokenColorCustomizations` `textMateRules`. The engine is rebuilt lazily after any of them changes.
 * A theme that is not installed falls back to VS Code's bundled default themes, and a language or grammar scope no
 * installed extension contributes to VS Code's bundled default grammars.
 */
export class SyntaxHighlighting implements vscode.Disposable {
  private current: Promise<LanguageHighlighter> | null = null;
  private hasReportedUnsupportedCustomizations = false;
  /** Theme ids and language ids already reported this session; each is reported once. */
  private readonly reportedMissingThemes = new Set<string>();
  private readonly reportedMissingGrammars = new Set<string>();
  private readonly subscriptions: readonly vscode.Disposable[];

  /**
   * `wasmPath` is the bundled `onig.wasm`, `defaultThemesDirectory` holds the {@link DEFAULT_THEMES} files,
   * `defaultGrammarsDirectory` the {@link DEFAULT_GRAMMARS_MANIFEST} and its grammars, and `onProblem` receives why a
   * theme or grammar could not be used.
   */
  constructor(
    private readonly wasmPath: string,
    private readonly defaultThemesDirectory: string,
    private readonly defaultGrammarsDirectory: string,
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
    if (scopeName === undefined) {
      this.reportMissingGrammar(languageId);
      return unstyledText(text);
    }
    return highlighter.highlight(text, scopeName, options);
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
    const { grammars: installedGrammars, themes: installedThemes } = collectContributions(vscode.extensions.all);
    const grammars = withDefaultGrammars(installedGrammars, await defaultGrammars(this.defaultGrammarsDirectory));
    const themes = [...installedThemes, ...defaultThemes(this.defaultThemesDirectory)];
    const { requestedId, theme } = activeTheme(themes);
    // For a theme that is not installed, VS Code itself shows an installed default theme, so using that one matches the editor.
    const isRequestedThemeMissing = requestedId !== undefined && findTheme(themes, requestedId) === null;
    const isEditorThemeUnavailable = theme === null || (isRequestedThemeMissing && !installedThemes.includes(theme));
    if (isEditorThemeUnavailable) {
      this.reportMissingTheme(requestedId, theme !== null);
    }

    this.reportUnsupportedCustomizations();
    const resolved = await resolveTheme(theme);
    resolved.problems.forEach((problem) => this.onProblem(problem));

    const highlighter = new TextMateHighlighter({ wasmPath: this.wasmPath, grammars, theme: resolved.theme, onProblem: this.onProblem });
    return { highlighter, scopeByLanguage: scopesByLanguage(grammars) };
  }

  /** Once per session per theme id, as a warning: every diff and merge view shows other colours than the editor, or none. */
  private reportMissingTheme(themeId: string | undefined, hasFallback: boolean): void {
    const reportKey = themeId ?? "";
    if (this.reportedMissingThemes.has(reportKey)) {
      return;
    }
    this.reportedMissingThemes.add(reportKey);
    const message = missingThemeMessage(themeId, { isRemoteHost: isRemote(), hasFallback });
    this.onProblem(message);
    void vscode.window.showWarningMessage(message);
  }

  /** Once per session per language, to the log only: one language without colours is not worth interrupting for. */
  private reportMissingGrammar(languageId: string): void {
    const isReported = this.reportedMissingGrammars.has(languageId) || LANGUAGES_WITHOUT_GRAMMAR.includes(languageId);
    if (isReported) {
      return;
    }
    this.reportedMissingGrammars.add(languageId);
    const location = isRemote() ? "installed extensions on the remote" : "installed extensions";
    this.onProblem(`No grammar for language '${languageId}' among ${location} or VS Code's default grammars; showing it without syntax colours.`);
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

/** Listed after the installed themes, so {@link findTheme} prefers an installed theme with the same id. */
function defaultThemes(directory: string): readonly ThemeContribution[] {
  return DEFAULT_THEMES.map(({ settingsId, uiTheme, file }) => ({ settingsId, uiTheme, path: path.join(directory, file) }));
}

async function defaultGrammars(directory: string): Promise<readonly GrammarContribution[]> {
  const manifest: unknown = JSON.parse(await readFile(path.join(directory, DEFAULT_GRAMMARS_MANIFEST), "utf8"));
  return Array.isArray(manifest) ? manifest.filter(isRecord).flatMap((entry) => toGrammar(entry, directory)) : [];
}

/**
 * Installed grammars, preceded by the default grammars. Listing the defaults first lets {@link scopesByLanguage} prefer
 * an installed grammar for a language; a default grammar it displaces stays available to grammars that embed its scope.
 * A default grammar whose scope is installed only keeps its language, mapped to the installed grammar's file.
 */
function withDefaultGrammars(installed: readonly GrammarContribution[], defaults: readonly GrammarContribution[]): readonly GrammarContribution[] {
  // Later contributions win, as in scopesByLanguage.
  const installedPaths = new Map(installed.map((grammar) => [grammar.scopeName, grammar.path]));
  const fallbacks = defaults.flatMap((grammar): GrammarContribution[] => {
    const installedPath = installedPaths.get(grammar.scopeName);
    if (installedPath === undefined) {
      return [grammar];
    }
    return grammar.language === undefined ? [] : [{ scopeName: grammar.scopeName, path: installedPath, language: grammar.language }];
  });
  return [...fallbacks, ...installed];
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

function isRemote(): boolean {
  return vscode.env.remoteName !== undefined;
}

/**
 * Why the colours differ from the editor's. A remote's extensions see neither VS Code's built-in themes nor themes
 * installed locally, since VS Code runs theme extensions in the local window.
 */
function missingThemeMessage(themeId: string | undefined, { isRemoteHost, hasFallback }: { isRemoteHost: boolean; hasFallback: boolean }): string {
  const theme = themeId === undefined ? "the active colour theme" : `the colour theme '${themeId}'`;
  const reason = isRemoteHost ? `${theme} is not available on the remote` : `${theme} was not found among installed extensions`;
  const outcome = hasFallback ? "shows code in VS Code's default colours" : "shows code without syntax colours";
  return `jw-differ ${outcome}: ${reason}.`;
}

/**
 * The theme named by `workbench.colorTheme`, unless VS Code picks the theme from the system: with
 * `window.autoDetectColorScheme` on, or when the active theme's kind differs from the configured one (as
 * `window.autoDetectHighContrast` does), the preferred theme for the active kind is in use instead.
 */
function activeTheme(themes: readonly ThemeContribution[]): ActiveThemeResult {
  const workbench = vscode.workspace.getConfiguration("workbench");
  const kind = vscode.window.activeColorTheme.kind;
  const configuredId = workbench.get<string>("colorTheme");
  const configured = findTheme(themes, configuredId);
  const isAutoDetected = vscode.workspace.getConfiguration("window").get<boolean>("autoDetectColorScheme") === true;
  const isConfiguredActive = configured !== null && UI_THEME_KINDS[configured.uiTheme ?? ""] === kind;
  const preferred = PREFERRED_THEMES[kind];
  if ((isConfiguredActive && !isAutoDetected) || preferred === undefined) {
    return { requestedId: configuredId, theme: configured };
  }

  const [preferredSetting, fallbackTheme] = preferred;
  const preferredId = workbench.get<string>(preferredSetting) ?? fallbackTheme;
  const theme = findTheme(themes, preferredId) ?? findTheme(themes, fallbackTheme) ?? configured;
  // A configured theme that is not found is still the one asked for; the default for the kind only stands in for it.
  const isPreferredRequested = isAutoDetected || configured !== null;
  return { requestedId: isPreferredRequested ? preferredId : configuredId, theme };
}

/** Built-in theme ids that newer VS Code renamed; it still accepts the old ids in settings and maps them like this. */
const RENAMED_THEME_IDS: Readonly<Record<string, string>> = {
  "Default Dark Modern": "Dark Modern",
  "Default Light Modern": "Light Modern",
  "Default Dark+": "Dark+",
  "Default Light+": "Light+",
  "Experimental Dark": "Dark 2026",
  "VS Code Dark": "Dark 2026",
  "Experimental Light": "Light 2026",
  "VS Code Light": "Light 2026",
};

/** The theme named `settingsId`, else the theme it was renamed to, so old ids work on VS Code before and after the rename. */
function findTheme(themes: readonly ThemeContribution[], settingsId: string | undefined): ThemeContribution | null {
  const renamedId = settingsId === undefined ? undefined : RENAMED_THEME_IDS[settingsId];
  return themes.find((theme) => theme.settingsId === settingsId) ?? themes.find((theme) => theme.settingsId === renamedId) ?? null;
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
