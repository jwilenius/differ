/**
 * Minimal runtime stand-in for the `vscode` module, aliased in `vitest.config.mts` for tests only.
 *
 * It records registrations, executed commands, shown messages and created UI items in `vscodeMock`, and lets tests
 * fire the events a host would raise. It is a fixture, not an emulator: only the members host code consumes exist.
 * Call `resetVscodeMock()` before each test so state cannot leak between tests.
 */
import * as path from "node:path";
import type * as vscode from "vscode";

type Listener<T> = (event: T) => unknown;
type CommandHandler = (...args: unknown[]) => unknown;
interface DisposableLike {
  dispose(): unknown;
}

export class Disposable {
  static from(...disposables: DisposableLike[]): Disposable {
    return new Disposable(() => disposables.forEach((disposable) => disposable.dispose()));
  }

  private isDisposed = false;

  constructor(private readonly callOnDispose: () => unknown) {}

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.callOnDispose();
  }
}

export class EventEmitter<T> {
  private listeners: readonly Listener<T>[] = [];

  readonly event = (listener: Listener<T>, thisArgs?: unknown, disposables?: DisposableLike[]): Disposable => {
    const bound: Listener<T> = (value) => listener.call(thisArgs, value);
    this.listeners = [...this.listeners, bound];
    const subscription = new Disposable(() => {
      this.listeners = this.listeners.filter((candidate) => candidate !== bound);
    });
    disposables?.push(subscription);
    return subscription;
  };

  fire(value: T): void {
    this.listeners.forEach((listener) => listener(value));
  }

  dispose(): void {
    this.listeners = [];
  }
}

export interface UriComponents {
  readonly scheme?: string;
  readonly authority?: string;
  readonly path?: string;
  readonly query?: string;
  readonly fragment?: string;
}

/** RFC 3986 appendix B. WHATWG `URL` is avoided: it strips newlines and collapses `..` segments. */
const URI_PATTERN = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;

export class Uri {
  static from(components: UriComponents): Uri {
    return new Uri(components);
  }

  static parse(value: string): Uri {
    const [, scheme = "", authority = "", encodedPath = "", query = "", fragment = ""] = URI_PATTERN.exec(value) ?? [];
    return new Uri({
      scheme,
      authority: decodeURIComponent(authority),
      path: decodeURIComponent(encodedPath),
      query: decodeURIComponent(query),
      fragment: decodeURIComponent(fragment),
    });
  }

  static file(fsPath: string): Uri {
    return new Uri({ scheme: "file", path: fsPath });
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return base.with({ path: path.posix.join(base.path, ...segments) });
  }

  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  private constructor(components: UriComponents) {
    this.scheme = components.scheme ?? "";
    this.authority = components.authority ?? "";
    this.path = components.path ?? "";
    this.query = components.query ?? "";
    this.fragment = components.fragment ?? "";
  }

  get fsPath(): string {
    return this.path;
  }

  with(change: UriComponents): Uri {
    return new Uri({ ...this.toJSON(), ...change });
  }

  toString(): string {
    const authority = this.authority === "" ? "" : `//${encodeURIComponent(this.authority)}`;
    const encodedPath = this.path.split("/").map(encodeURIComponent).join("/");
    const query = this.query === "" ? "" : `?${encodeURIComponent(this.query)}`;
    const fragment = this.fragment === "" ? "" : `#${encodeURIComponent(this.fragment)}`;
    return `${this.scheme}:${authority}${encodedPath}${query}${fragment}`;
  }

  toJSON(): Required<UriComponents> {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
    };
  }
}

/** A glob pattern matched relative to `baseUri`, as `workspace.createFileSystemWatcher` takes one. */
export class RelativePattern {
  constructor(
    readonly baseUri: Uri,
    readonly pattern: string,
  ) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}

export interface FakeReplacement {
  readonly uri: Uri;
  readonly range: Range;
  readonly text: string;
}

/** Records replacements; `workspace.applyEdit` appends them to `vscodeMock.appliedEdits`. */
export class WorkspaceEdit {
  readonly replacements: FakeReplacement[] = [];

  replace(uri: Uri, range: Range, text: string): void {
    this.replacements.push({ uri, range, text });
  }
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

/** The members of `vscode.Extension` host code reads. */
export interface FakeExtension {
  readonly id: string;
  readonly extensionPath: string;
  readonly packageJSON: unknown;
}

export interface ExecutedCommand {
  readonly command: string;
  readonly args: readonly unknown[];
}

export interface ShownMessage {
  readonly level: "error" | "warning" | "information";
  readonly text: string;
}

export interface ShownDocument {
  readonly document: vscode.TextDocument;
  readonly options: vscode.TextDocumentShowOptions | undefined;
}

export interface QuickPickRequest {
  readonly items: readonly vscode.QuickPickItem[];
  readonly options: vscode.QuickPickOptions;
}

export interface FakeStatusBarItem {
  readonly alignment: StatusBarAlignment;
  readonly priority: number | undefined;
  text: string;
  tooltip: unknown;
  command: unknown;
  isVisible: boolean;
  isDisposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface FakeOutputChannel {
  readonly name: string;
  readonly lines: string[];
  isDisposed: boolean;
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** Observable registrations and configurable responses; cleared in place by `resetVscodeMock()`. */
export interface VscodeMockState {
  readonly commands: Map<string, CommandHandler>;
  readonly executedCommands: ExecutedCommand[];
  readonly contentProviders: Map<string, vscode.TextDocumentContentProvider>;
  readonly webviewViewProviders: Map<string, vscode.WebviewViewProvider>;
  readonly statusBarItems: FakeStatusBarItem[];
  readonly outputChannels: FakeOutputChannel[];
  readonly messages: ShownMessage[];
  /** Documents and options of each `window.showTextDocument` call. */
  readonly shownDocuments: ShownDocument[];
  readonly openDialogRequests: vscode.OpenDialogOptions[];
  /** Items and options of each `window.showQuickPick` call. */
  readonly quickPickRequests: QuickPickRequest[];
  /** Index of the item `showQuickPick` returns; undefined cancels the pick. */
  quickPickChoice: number | undefined;
  /** Answers each `window.showWarningMessage` with the returned item, which may come later; when absent, or answering undefined, it is dismissed. */
  warningMessageResponse: ((text: string) => string | undefined | Promise<string | undefined>) | undefined;
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  activeTextEditor: vscode.TextEditor | undefined;
  openDialogResponse: Uri[] | undefined;
  /** `vscode.extensions.all`. */
  extensions: FakeExtension[];
  /** Settings by full key, such as `workbench.colorTheme`; read through `workspace.getConfiguration`. */
  readonly configuration: Map<string, unknown>;
  colorThemeKind: ColorThemeKind;
  /** `env.remoteName`: the remote authority kind, such as `ssh-remote`; undefined in a local window. */
  remoteName: string | undefined;
  /** `workspace.textDocuments`; `openTextDocument` adds to it and `fireDidCloseTextDocument` removes from it. */
  readonly textDocuments: vscode.TextDocument[];
  /** Language ids `openTextDocument` assigns by file extension, such as `.ts` → `typescript`; else `plaintext`. */
  readonly languageIds: Map<string, string>;
  /** Opens `file:` documents for `openTextDocument`; when absent, they open like content-provider documents. */
  openFileDocument: ((uri: Uri) => vscode.TextDocument) | undefined;
  readonly webviewPanels: FakeWebviewPanel[];
  /** Replacements of every `workspace.applyEdit` call, in order. */
  readonly appliedEdits: FakeReplacement[];
  /** Watchers made by `workspace.createFileSystemWatcher`, in creation order. */
  readonly fileSystemWatchers: FakeFileSystemWatcher[];
}

export const vscodeMock: VscodeMockState = {
  commands: new Map(),
  executedCommands: [],
  contentProviders: new Map(),
  webviewViewProviders: new Map(),
  statusBarItems: [],
  outputChannels: [],
  messages: [],
  shownDocuments: [],
  openDialogRequests: [],
  quickPickRequests: [],
  quickPickChoice: undefined,
  warningMessageResponse: undefined,
  workspaceFolders: undefined,
  activeTextEditor: undefined,
  openDialogResponse: undefined,
  extensions: [],
  configuration: new Map(),
  colorThemeKind: ColorThemeKind.Dark,
  remoteName: undefined,
  textDocuments: [],
  languageIds: new Map(),
  openFileDocument: undefined,
  webviewPanels: [],
  appliedEdits: [],
  fileSystemWatchers: [],
};

let didCloseTextDocument = new EventEmitter<vscode.TextDocument>();
let didChangeTextDocument = new EventEmitter<vscode.TextDocumentChangeEvent>();
let didChangeActiveTextEditor = new EventEmitter<vscode.TextEditor | undefined>();
let didChangeWorkspaceFolders = new EventEmitter<vscode.WorkspaceFoldersChangeEvent>();
let didChangeConfiguration = new EventEmitter<vscode.ConfigurationChangeEvent>();
let didChangeExtensions = new EventEmitter<void>();
let didChangeActiveColorTheme = new EventEmitter<{ readonly kind: ColorThemeKind }>();
let didChangeWindowState = new EventEmitter<{ readonly focused: boolean }>();

export function resetVscodeMock(): void {
  vscodeMock.commands.clear();
  vscodeMock.executedCommands.length = 0;
  vscodeMock.contentProviders.clear();
  vscodeMock.webviewViewProviders.clear();
  vscodeMock.statusBarItems.length = 0;
  vscodeMock.outputChannels.length = 0;
  vscodeMock.messages.length = 0;
  vscodeMock.shownDocuments.length = 0;
  vscodeMock.openDialogRequests.length = 0;
  vscodeMock.quickPickRequests.length = 0;
  vscodeMock.quickPickChoice = undefined;
  vscodeMock.warningMessageResponse = undefined;
  vscodeMock.workspaceFolders = undefined;
  vscodeMock.activeTextEditor = undefined;
  vscodeMock.openDialogResponse = undefined;
  vscodeMock.extensions = [];
  vscodeMock.configuration.clear();
  vscodeMock.colorThemeKind = ColorThemeKind.Dark;
  vscodeMock.remoteName = undefined;
  vscodeMock.textDocuments.length = 0;
  vscodeMock.languageIds.clear();
  vscodeMock.openFileDocument = undefined;
  vscodeMock.webviewPanels.length = 0;
  vscodeMock.appliedEdits.length = 0;
  vscodeMock.fileSystemWatchers.length = 0;
  didCloseTextDocument = new EventEmitter();
  didChangeTextDocument = new EventEmitter();
  didChangeActiveTextEditor = new EventEmitter();
  didChangeWorkspaceFolders = new EventEmitter();
  didChangeConfiguration = new EventEmitter();
  didChangeExtensions = new EventEmitter();
  didChangeActiveColorTheme = new EventEmitter();
  didChangeWindowState = new EventEmitter();
}

/** Sets a setting by full key and reports it as changed, affecting that key and its enclosing sections. */
export function changeConfiguration(key: string, value: unknown): void {
  vscodeMock.configuration.set(key, value);
  didChangeConfiguration.fire({ affectsConfiguration: (section) => key === section || key.startsWith(`${section}.`) });
}

/** Replaces `vscode.extensions.all` and reports the change. */
export function changeExtensions(extensions: FakeExtension[]): void {
  vscodeMock.extensions = extensions;
  didChangeExtensions.fire();
}

export function changeColorThemeKind(kind: ColorThemeKind): void {
  vscodeMock.colorThemeKind = kind;
  didChangeActiveColorTheme.fire({ kind });
}

/** Reports the window gaining or losing focus. */
export function changeWindowFocus(isFocused: boolean): void {
  didChangeWindowState.fire({ focused: isFocused });
}

export function fireDidCloseTextDocument(document: vscode.TextDocument): void {
  const index = vscodeMock.textDocuments.findIndex((open) => open.uri.toString() === document.uri.toString());
  if (index >= 0) {
    vscodeMock.textDocuments.splice(index, 1);
  }
  didCloseTextDocument.fire(document);
}

/** Replaces `vscodeMock.workspaceFolders` and reports the change as VS Code would. */
export function changeWorkspaceFolders(folders: readonly vscode.WorkspaceFolder[]): void {
  const previous = vscodeMock.workspaceFolders ?? [];
  vscodeMock.workspaceFolders = folders;
  didChangeWorkspaceFolders.fire({
    added: folders.filter((folder) => !previous.includes(folder)),
    removed: previous.filter((folder) => !folders.includes(folder)),
  });
}

/** Registers `value` under `key` until the returned disposable runs, which removes only that registration. */
function register<T>(registry: Map<string, T>, key: string, value: T): Disposable {
  registry.set(key, value);
  return new Disposable(() => {
    if (registry.get(key) === value) {
      registry.delete(key);
    }
  });
}

export const commands = {
  registerCommand(command: string, handler: CommandHandler): Disposable {
    return register(vscodeMock.commands, command, handler);
  },

  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    vscodeMock.executedCommands.push({ command, args });
    return vscodeMock.commands.get(command)?.(...args);
  },
};

export const workspace = {
  get workspaceFolders(): readonly vscode.WorkspaceFolder[] | undefined {
    return vscodeMock.workspaceFolders;
  },

  getConfiguration(section: string): { get<T>(key: string, defaultValue?: T): T | undefined } {
    return {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        const fullKey = `${section}.${key}`;
        return vscodeMock.configuration.has(fullKey) ? (vscodeMock.configuration.get(fullKey) as T) : defaultValue;
      },
    };
  },

  onDidChangeConfiguration(
    listener: Listener<vscode.ConfigurationChangeEvent>,
    thisArgs?: unknown,
    disposables?: DisposableLike[],
  ): Disposable {
    return didChangeConfiguration.event(listener, thisArgs, disposables);
  },

  /** The path relative to the first workspace folder containing it, else unchanged. */
  asRelativePath(pathOrUri: string | Uri): string {
    const filePath = typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
    const folder = vscodeMock.workspaceFolders?.find((candidate) => filePath.startsWith(`${candidate.uri.fsPath}${path.sep}`));
    return folder ? path.relative(folder.uri.fsPath, filePath) : filePath;
  },

  get textDocuments(): readonly vscode.TextDocument[] {
    return vscodeMock.textDocuments;
  },

  /**
   * Serves `file:` documents from `vscodeMock.openFileDocument` when set, reusing one still open as VS Code does, else
   * registered content-provider documents whose language comes from `vscodeMock.languageIds`.
   */
  async openTextDocument(uri: Uri): Promise<vscode.TextDocument> {
    if (uri.scheme === "file" && vscodeMock.openFileDocument) {
      const openDocument = vscodeMock.textDocuments.find((open) => open.uri.toString() === uri.toString());
      if (openDocument) {
        return openDocument;
      }
      const fileDocument = vscodeMock.openFileDocument(uri);
      vscodeMock.textDocuments.push(fileDocument);
      return fileDocument;
    }
    const text = vscodeMock.contentProviders.get(uri.scheme)?.provideTextDocumentContent(uri as unknown as vscode.Uri, {} as vscode.CancellationToken);
    const languageId = vscodeMock.languageIds.get(path.posix.extname(uri.path)) ?? "plaintext";
    const document = { uri, languageId, getText: () => text ?? "" } as unknown as vscode.TextDocument;
    vscodeMock.textDocuments.push(document);
    return document;
  },

  applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    vscodeMock.appliedEdits.push(...edit.replacements);
    return Promise.resolve(true);
  },

  registerTextDocumentContentProvider(scheme: string, provider: vscode.TextDocumentContentProvider): Disposable {
    return register(vscodeMock.contentProviders, scheme, provider);
  },

  createFileSystemWatcher(globPattern: string | RelativePattern): FakeFileSystemWatcher {
    const watcher = new FakeFileSystemWatcher(globPattern);
    vscodeMock.fileSystemWatchers.push(watcher);
    return watcher;
  },

  onDidCloseTextDocument(listener: Listener<vscode.TextDocument>, thisArgs?: unknown, disposables?: DisposableLike[]): Disposable {
    return didCloseTextDocument.event(listener, thisArgs, disposables);
  },

  onDidChangeWorkspaceFolders(
    listener: Listener<vscode.WorkspaceFoldersChangeEvent>,
    thisArgs?: unknown,
    disposables?: DisposableLike[],
  ): Disposable {
    return didChangeWorkspaceFolders.event(listener, thisArgs, disposables);
  },

  onDidChangeTextDocument(
    listener: Listener<vscode.TextDocumentChangeEvent>,
    thisArgs?: unknown,
    disposables?: DisposableLike[],
  ): Disposable {
    return didChangeTextDocument.event(listener, thisArgs, disposables);
  },
};

function showMessage(level: ShownMessage["level"], text: string): Promise<undefined> {
  vscodeMock.messages.push({ level, text });
  return Promise.resolve(undefined);
}

function createStatusBarItem(alignment = StatusBarAlignment.Left, priority?: number): FakeStatusBarItem {
  const item: FakeStatusBarItem = {
    alignment,
    priority,
    text: "",
    tooltip: undefined,
    command: undefined,
    isVisible: false,
    isDisposed: false,
    show: () => void (item.isVisible = true),
    hide: () => void (item.isVisible = false),
    dispose: () => void (item.isDisposed = true),
  };
  vscodeMock.statusBarItems.push(item);
  return item;
}

function createOutputChannel(name: string): FakeOutputChannel {
  const channel: FakeOutputChannel = {
    name,
    lines: [],
    isDisposed: false,
    append: (value) => void channel.lines.push(value),
    appendLine: (value) => void channel.lines.push(value),
    clear: () => void (channel.lines.length = 0),
    show: () => undefined,
    hide: () => undefined,
    dispose: () => void (channel.isDisposed = true),
  };
  vscodeMock.outputChannels.push(channel);
  return channel;
}

export const env = {
  get remoteName(): string | undefined {
    return vscodeMock.remoteName;
  },
};

export const extensions = {
  get all(): readonly FakeExtension[] {
    return vscodeMock.extensions;
  },

  onDidChange(listener: Listener<void>, thisArgs?: unknown, disposables?: DisposableLike[]): Disposable {
    return didChangeExtensions.event(listener, thisArgs, disposables);
  },
};

export const window = {
  get activeTextEditor(): vscode.TextEditor | undefined {
    return vscodeMock.activeTextEditor;
  },

  get activeColorTheme(): { readonly kind: ColorThemeKind } {
    return { kind: vscodeMock.colorThemeKind };
  },

  onDidChangeActiveColorTheme(
    listener: Listener<{ readonly kind: ColorThemeKind }>,
    thisArgs?: unknown,
    disposables?: DisposableLike[],
  ): Disposable {
    return didChangeActiveColorTheme.event(listener, thisArgs, disposables);
  },

  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: ViewColumn | { readonly viewColumn: ViewColumn; readonly preserveFocus?: boolean },
    options: vscode.WebviewPanelOptions & vscode.WebviewOptions = {},
  ): FakeWebviewPanel {
    const panel = new FakeWebviewPanel(viewType, title, showOptions, options);
    vscodeMock.webviewPanels.push(panel);
    return panel;
  },

  registerWebviewViewProvider(viewId: string, provider: vscode.WebviewViewProvider): Disposable {
    return register(vscodeMock.webviewViewProviders, viewId, provider);
  },

  createStatusBarItem,
  createOutputChannel,

  showOpenDialog(options?: vscode.OpenDialogOptions): Promise<Uri[] | undefined> {
    vscodeMock.openDialogRequests.push(options ?? {});
    return Promise.resolve(vscodeMock.openDialogResponse);
  },

  showTextDocument(document: vscode.TextDocument, options?: vscode.TextDocumentShowOptions): Promise<vscode.TextEditor> {
    vscodeMock.shownDocuments.push({ document, options });
    return Promise.resolve({ document } as vscode.TextEditor);
  },

  async showQuickPick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions = {}): Promise<T | undefined> {
    vscodeMock.quickPickRequests.push({ items, options });
    return vscodeMock.quickPickChoice === undefined ? undefined : items[vscodeMock.quickPickChoice];
  },

  showErrorMessage: (text: string) => showMessage("error", text),
  async showWarningMessage(text: string): Promise<string | undefined> {
    await showMessage("warning", text);
    return vscodeMock.warningMessageResponse?.(text);
  },
  showInformationMessage: (text: string) => showMessage("information", text),

  onDidChangeActiveTextEditor(
    listener: Listener<vscode.TextEditor | undefined>,
    thisArgs?: unknown,
    disposables?: DisposableLike[],
  ): Disposable {
    return didChangeActiveTextEditor.event(listener, thisArgs, disposables);
  },

  onDidChangeWindowState(listener: Listener<{ readonly focused: boolean }>, thisArgs?: unknown, disposables?: DisposableLike[]): Disposable {
    return didChangeWindowState.event(listener, thisArgs, disposables);
  },
};

export class FakeWebview implements vscode.Webview {
  options: vscode.WebviewOptions = {};
  /** Set when the owning panel is disposed; like VS Code's, the webview then refuses new content. */
  isDisposed = false;
  private content = "";
  readonly cspSource = "vscode-webview://fake";
  readonly postedMessages: unknown[] = [];
  /** How often `html` was assigned; each assignment reloads a real webview's document. */
  htmlWrites = 0;
  private documentMessageStart = 0;
  private readonly didReceiveMessage = new EventEmitter<unknown>();
  readonly onDidReceiveMessage = this.didReceiveMessage.event;

  get html(): string {
    return this.content;
  }

  set html(value: string) {
    if (this.isDisposed) {
      throw new Error("Webview is disposed");
    }
    this.content = value;
    this.htmlWrites += 1;
    this.documentMessageStart = this.postedMessages.length;
  }

  /** Messages posted since `html` was last assigned: the only ones its document can receive. */
  get postedSinceHtml(): readonly unknown[] {
    return this.postedMessages.slice(this.documentMessageStart);
  }

  postMessage(message: unknown): Promise<boolean> {
    this.postedMessages.push(message);
    return Promise.resolve(true);
  }

  asWebviewUri(localResource: Uri): Uri {
    return localResource.with({ scheme: "vscode-webview-resource" });
  }

  /** Delivers a message as if the webview script had posted it. */
  fireDidReceiveMessage(message: unknown): void {
    this.didReceiveMessage.fire(message);
  }
}

export class FakeWebviewView implements vscode.WebviewView {
  readonly webview = new FakeWebview();
  title?: string;
  description?: string;
  visible = true;
  revealCount = 0;
  private readonly didDispose = new EventEmitter<void>();
  private readonly didChangeVisibility = new EventEmitter<void>();
  readonly onDidDispose = this.didDispose.event;
  readonly onDidChangeVisibility = this.didChangeVisibility.event;

  constructor(readonly viewType: string) {}

  show(): void {
    this.revealCount += 1;
  }

  fireDidDispose(): void {
    this.didDispose.fire();
  }

  fireDidChangeVisibility(isVisible: boolean): void {
    this.visible = isVisible;
    this.didChangeVisibility.fire();
  }
}

export function createFakeWebviewView(viewType = "jwDiffer.history"): FakeWebviewView {
  return new FakeWebviewView(viewType);
}

/** A watcher of `globPattern` whose changes tests report through `fireDidChange`. */
export class FakeFileSystemWatcher {
  isDisposed = false;
  private readonly didChange = new EventEmitter<Uri>();
  private readonly didCreate = new EventEmitter<Uri>();
  private readonly didDelete = new EventEmitter<Uri>();
  readonly onDidChange = this.didChange.event;
  readonly onDidCreate = this.didCreate.event;
  readonly onDidDelete = this.didDelete.event;

  constructor(readonly globPattern: string | RelativePattern) {}

  fireDidChange(uri: Uri): void {
    this.didChange.fire(uri);
  }

  dispose(): void {
    this.isDisposed = true;
  }
}

/** Records how it was created; `dispose()` raises `onDidDispose` once, as closing the editor tab would. */
export class FakeWebviewPanel {
  readonly webview = new FakeWebview();
  revealCount = 0;
  isDisposed = false;
  private readonly didDispose = new EventEmitter<void>();
  readonly onDidDispose = this.didDispose.event;

  constructor(
    readonly viewType: string,
    private titleText: string,
    readonly showOptions: ViewColumn | { readonly viewColumn: ViewColumn; readonly preserveFocus?: boolean },
    readonly options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
  ) {
    this.webview.options = options;
  }

  /** Like VS Code's, the title can no longer be read or changed once the panel is disposed. */
  get title(): string {
    this.assertNotDisposed();
    return this.titleText;
  }

  set title(value: string) {
    this.assertNotDisposed();
    this.titleText = value;
  }

  reveal(): void {
    this.revealCount += 1;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.webview.isDisposed = true;
    this.didDispose.fire();
  }

  private assertNotDisposed(): void {
    if (this.isDisposed) {
      throw new Error("Webview is disposed");
    }
  }
}
