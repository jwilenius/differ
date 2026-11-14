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
  readonly openDialogRequests: vscode.OpenDialogOptions[];
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  activeTextEditor: vscode.TextEditor | undefined;
  openDialogResponse: Uri[] | undefined;
  /** `vscode.extensions.all`. */
  extensions: FakeExtension[];
  /** Settings by full key, such as `workbench.colorTheme`; read through `workspace.getConfiguration`. */
  readonly configuration: Map<string, unknown>;
  colorThemeKind: ColorThemeKind;
  /** `workspace.textDocuments`; `openTextDocument` adds to it and `fireDidCloseTextDocument` removes from it. */
  readonly textDocuments: vscode.TextDocument[];
  /** Language ids `openTextDocument` assigns by file extension, such as `.ts` → `typescript`; else `plaintext`. */
  readonly languageIds: Map<string, string>;
  readonly webviewPanels: FakeWebviewPanel[];
}

export const vscodeMock: VscodeMockState = {
  commands: new Map(),
  executedCommands: [],
  contentProviders: new Map(),
  webviewViewProviders: new Map(),
  statusBarItems: [],
  outputChannels: [],
  messages: [],
  openDialogRequests: [],
  workspaceFolders: undefined,
  activeTextEditor: undefined,
  openDialogResponse: undefined,
  extensions: [],
  configuration: new Map(),
  colorThemeKind: ColorThemeKind.Dark,
  textDocuments: [],
  languageIds: new Map(),
  webviewPanels: [],
};

let didCloseTextDocument = new EventEmitter<vscode.TextDocument>();
let didChangeTextDocument = new EventEmitter<vscode.TextDocumentChangeEvent>();
let didChangeActiveTextEditor = new EventEmitter<vscode.TextEditor | undefined>();
let didChangeWorkspaceFolders = new EventEmitter<vscode.WorkspaceFoldersChangeEvent>();
let didChangeConfiguration = new EventEmitter<vscode.ConfigurationChangeEvent>();
let didChangeExtensions = new EventEmitter<void>();
let didChangeActiveColorTheme = new EventEmitter<{ readonly kind: ColorThemeKind }>();

export function resetVscodeMock(): void {
  vscodeMock.commands.clear();
  vscodeMock.executedCommands.length = 0;
  vscodeMock.contentProviders.clear();
  vscodeMock.webviewViewProviders.clear();
  vscodeMock.statusBarItems.length = 0;
  vscodeMock.outputChannels.length = 0;
  vscodeMock.messages.length = 0;
  vscodeMock.openDialogRequests.length = 0;
  vscodeMock.workspaceFolders = undefined;
  vscodeMock.activeTextEditor = undefined;
  vscodeMock.openDialogResponse = undefined;
  vscodeMock.extensions = [];
  vscodeMock.configuration.clear();
  vscodeMock.colorThemeKind = ColorThemeKind.Dark;
  vscodeMock.textDocuments.length = 0;
  vscodeMock.languageIds.clear();
  vscodeMock.webviewPanels.length = 0;
  didCloseTextDocument = new EventEmitter();
  didChangeTextDocument = new EventEmitter();
  didChangeActiveTextEditor = new EventEmitter();
  didChangeWorkspaceFolders = new EventEmitter();
  didChangeConfiguration = new EventEmitter();
  didChangeExtensions = new EventEmitter();
  didChangeActiveColorTheme = new EventEmitter();
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

  get textDocuments(): readonly vscode.TextDocument[] {
    return vscodeMock.textDocuments;
  },

  /** Serves registered content-provider documents; the language comes from `vscodeMock.languageIds`. */
  async openTextDocument(uri: Uri): Promise<vscode.TextDocument> {
    const text = vscodeMock.contentProviders.get(uri.scheme)?.provideTextDocumentContent(uri as unknown as vscode.Uri, {} as vscode.CancellationToken);
    const languageId = vscodeMock.languageIds.get(path.posix.extname(uri.path)) ?? "plaintext";
    const document = { uri, languageId, getText: () => text ?? "" } as unknown as vscode.TextDocument;
    vscodeMock.textDocuments.push(document);
    return document;
  },

  registerTextDocumentContentProvider(scheme: string, provider: vscode.TextDocumentContentProvider): Disposable {
    return register(vscodeMock.contentProviders, scheme, provider);
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

  showErrorMessage: (text: string) => showMessage("error", text),
  showWarningMessage: (text: string) => showMessage("warning", text),
  showInformationMessage: (text: string) => showMessage("information", text),

  onDidChangeActiveTextEditor(
    listener: Listener<vscode.TextEditor | undefined>,
    thisArgs?: unknown,
    disposables?: DisposableLike[],
  ): Disposable {
    return didChangeActiveTextEditor.event(listener, thisArgs, disposables);
  },
};

export class FakeWebview implements vscode.Webview {
  options: vscode.WebviewOptions = {};
  html = "";
  readonly cspSource = "vscode-webview://fake";
  readonly postedMessages: unknown[] = [];
  private readonly didReceiveMessage = new EventEmitter<unknown>();
  readonly onDidReceiveMessage = this.didReceiveMessage.event;

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

export function createFakeWebviewView(viewType = "differ.history"): FakeWebviewView {
  return new FakeWebviewView(viewType);
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
    public title: string,
    readonly showOptions: ViewColumn | { readonly viewColumn: ViewColumn; readonly preserveFocus?: boolean },
    readonly options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
  ) {
    this.webview.options = options;
  }

  reveal(): void {
    this.revealCount += 1;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.didDispose.fire();
  }
}
