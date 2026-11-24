import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import * as vscode from "vscode";
import { TOKENIZE_TIME_BUDGET_MS, unstyledText, type HighlightOptions } from "../../highlight/textMateHighlighter";
import { correspondingLine } from "../../model/correspondingLine";
import type { HighlightedText } from "../../model/syntaxTokens";
import { buildTwoWayDiff } from "../../model/twoWayDiff";
import { HtmlTwoWayDiffRenderer, type FileListNeighbours, type StartChange } from "../../render/html/twoWayDiffRenderer";

const VIEW_TYPE = "jwDiffer.twoWayDiff";
const NONCE_BYTES = 16;
/** How long a panel waits for highlighting, such as a theme file that never finishes reading, before showing plain text. */
const HIGHLIGHT_TIMEOUT_MS = 3_000;
/**
 * Settings that change token colours; `SyntaxHighlighting` drops its engine on them before the panel re-highlights.
 * A `workbench.colorTheme` change is left to the active-theme event: the setting changes before the active theme's
 * kind does, so highlighting on it would briefly pick the wrong theme.
 */
const COLOR_SETTINGS: readonly string[] = ["editor.tokenColorCustomizations"];
/**
 * Serves an empty document at any path, so VS Code gives a file that cannot open, as a deleted one, the language of its
 * name.
 */
const FILE_NAME_LANGUAGE_SCHEME = "jw-differ-file-name";
/** A file list whose neighbouring files are still being found: no step yet either way. */
const PENDING_NEIGHBOURS: FileListNeighbours = { hasPrevious: false, hasNext: false, isPending: true };

/** Tokenizes text for one language; implemented by `SyntaxHighlighting`. */
export interface TextHighlighter {
  highlight(text: string, languageId: string, options?: HighlightOptions): Promise<HighlightedText>;
}

/** One side of a comparison: its cached document, the text it serves, and how the header names it. */
export interface DiffSide {
  readonly uri: vscode.Uri;
  readonly text: string;
  readonly label: string;
  readonly path: string;
}

export type FileDirection = "previous" | "next";

/** Opens the neighbouring files of a comparison's file list; a missing direction has no file to open. */
export type AdjacentFiles = Readonly<Partial<Record<FileDirection, () => Promise<void>>>>;

/** Everything a panel shows and the hooks back into the document cache that owns `base.uri` and `result.uri`. */
export interface TwoWayDiffRequest {
  readonly title: string;
  readonly base: DiffSide;
  readonly result: DiffSide;
  /** The document whose VS Code language decides highlighting for both sides. */
  readonly languageUri: vscode.Uri;
  /** Shows the same comparison in VS Code's built-in diff editor. */
  openNative(): Thenable<unknown>;
  /** Called once when the tab starts showing this comparison, before the comparison it replaced is released. */
  shown?(): void;
  /** Called once when the panel closes; the cached documents may then be forgotten. */
  release(): void;
  /**
   * Set when the diff belongs to a file list: F7 past the last change, or Shift+F7 before the first, then offers the
   * neighbouring file. Called once the tab shows this diff, with a signal that aborts once the tab stops showing it;
   * until it resolves the diff offers no step and says it is looking. Without it both keys stop at either end.
   */
  readonly findAdjacentFiles?: (signal: AbortSignal) => Promise<AdjacentFiles>;
  /** Defaults to the first change. */
  readonly startAt?: StartChange;
  /** The right side's file in the working tree, which F4 opens; absent when the right side deletes the file. */
  readonly workingCopy?: vscode.Uri;
}

export interface TwoWayDiffPanelsOptions {
  readonly mediaRoot: vscode.Uri;
  readonly highlighter: TextHighlighter;
  readonly log: (message: string) => void;
  /** Defaults to {@link HIGHLIGHT_TIMEOUT_MS}. */
  readonly highlightTimeoutMs?: number;
}

type SideHighlights = readonly [base: HighlightedText, result: HighlightedText];

/** The single diff tab and the comparison it currently shows. */
interface OpenPanel {
  readonly panel: vscode.WebviewPanel;
  request: TwoWayDiffRequest;
  /** The number of the page showing `request`; messages a page of an earlier comparison sent are dropped. */
  page: number;
  /** What `request.findAdjacentFiles` found; null until it resolves, or when the diff has no file list. */
  adjacentFiles: AdjacentFiles | null;
  /** Aborts the search for `request`'s neighbouring files once the tab moves on or closes. */
  findingNeighbours: AbortController;
}

/**
 * Shows IntelliJ-style side-by-side diffs in one reusable editor tab, as VS Code's preview diff does: opening another
 * file replaces the tab's content and releases the comparison it showed. Closes the tab on dispose.
 */
export class TwoWayDiffPanels implements vscode.Disposable {
  private current: OpenPanel | null = null;
  private isDisposed = false;
  /** Highlighting of the latest `open`; an `open` that finds another one here was superseded. */
  private openHighlighting: AbortController | null = null;
  /** Highlighting of the latest colour refresh, superseded the same way. */
  private refreshHighlighting: AbortController | null = null;
  /** Counts colour changes, so an `open` that highlighted across one re-highlights after showing. */
  private colorGeneration = 0;
  /** Counts the comparisons shown, numbering their pages. */
  private pageCount = 0;
  private readonly subscriptions: readonly vscode.Disposable[];

  constructor(private readonly options: TwoWayDiffPanelsOptions) {
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider(FILE_NAME_LANGUAGE_SCHEME, { provideTextDocumentContent: () => "" }),
      vscode.window.onDidChangeActiveColorTheme(() => this.onColorsChanged()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (COLOR_SETTINGS.some((setting) => event.affectsConfiguration(setting))) {
          this.onColorsChanged();
        }
      }),
    ];
  }

  /**
   * Highlights both sides, then shows them; highlighting problems fall back to unstyled text. Releases the request at
   * once when shut down or superseded by a later `open` meanwhile; rejects, leaving the tab as it was, when rendering fails.
   */
  async open(request: TwoWayDiffRequest): Promise<void> {
    this.openHighlighting?.abort();
    // The shown comparison is about to be replaced, so its re-highlighting is wasted work.
    this.refreshHighlighting?.abort();
    this.refreshHighlighting = null;
    const highlighting = new AbortController();
    this.openHighlighting = highlighting;
    const generation = this.colorGeneration;

    const highlights = await this.highlightSides(request, highlighting);
    const isSuperseded = this.openHighlighting !== highlighting;
    if (this.isDisposed || isSuperseded) {
      request.release();
      return;
    }
    this.openHighlighting = null;
    this.show(request, highlights);
    if (generation !== this.colorGeneration) {
      void this.refresh();
    }
  }

  dispose(): void {
    this.isDisposed = true;
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.openHighlighting?.abort();
    this.refreshHighlighting?.abort();
    this.current?.panel.dispose();
  }

  private show(request: TwoWayDiffRequest, highlights: SideHighlights): void {
    const page = ++this.pageCount;
    const isNewPanel = this.current === null;
    const open = this.current ?? this.createPanel(request, page);
    try {
      open.panel.webview.html = this.render(open.panel.webview, request, highlights, page, null);
    } catch (error) {
      if (isNewPanel) {
        open.panel.dispose();
      } else {
        request.release();
      }
      throw error;
    }
    if (isNewPanel) {
      request.shown?.();
    } else {
      const previous = open.request;
      open.request = request;
      open.page = page;
      open.adjacentFiles = null;
      open.findingNeighbours.abort();
      open.findingNeighbours = new AbortController();
      open.panel.title = request.title;
      open.panel.reveal(undefined, false);
      request.shown?.();
      previous.release();
    }
    void this.findAdjacentFiles(open, request);
  }

  /**
   * Finds the shown diff's neighbouring files and sends them to its page; dropped once the tab has moved on. A failure
   * offers no step.
   */
  private async findAdjacentFiles(open: OpenPanel, request: TwoWayDiffRequest): Promise<void> {
    if (request.findAdjacentFiles === undefined) {
      return;
    }
    let adjacentFiles: AdjacentFiles;
    try {
      adjacentFiles = await request.findAdjacentFiles(open.findingNeighbours.signal);
    } catch (error) {
      this.options.log(`Finding the files next to ${request.title} failed. ${messageOf(error)}`);
      adjacentFiles = {};
    }
    const isShown = !this.isDisposed && this.current === open && open.request === request;
    if (!isShown) {
      return;
    }
    open.adjacentFiles = adjacentFiles;
    void open.panel.webview.postMessage({ type: "fileList", page: open.page, ...neighboursOf(adjacentFiles) });
  }

  private onColorsChanged(): void {
    this.colorGeneration += 1;
    void this.refresh();
  }

  /** Re-highlights the shown comparison in the new colours; skipped when the tab has moved on meanwhile. */
  private async refresh(): Promise<void> {
    const open = this.current;
    if (open === null) {
      return;
    }
    this.refreshHighlighting?.abort();
    const highlighting = new AbortController();
    this.refreshHighlighting = highlighting;

    const shown = open.request;
    const highlights = await this.highlightSides(shown, highlighting);
    const isStale = this.isDisposed || this.refreshHighlighting !== highlighting || this.current !== open || open.request !== shown;
    if (isStale) {
      return;
    }
    try {
      open.panel.webview.html = this.render(open.panel.webview, shown, highlights, open.page, open.adjacentFiles);
    } catch (error) {
      this.options.log(`Re-rendering ${shown.title} in the new colours failed. ${messageOf(error)}`);
    }
  }

  private createPanel(request: TwoWayDiffRequest, page: number): OpenPanel {
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      request.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true, localResourceRoots: [this.options.mediaRoot] },
    );
    const open: OpenPanel = { panel, request, page, adjacentFiles: null, findingNeighbours: new AbortController() };
    this.current = open;

    const messages = panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message, open));
    panel.onDidDispose(() => {
      messages.dispose();
      open.findingNeighbours.abort();
      if (this.current === open) {
        this.current = null;
      }
      open.request.release();
    });
    return open;
  }

  /**
   * Both sides share one tokenizing budget. Gives up after the highlight timeout, aborting `highlighting` so
   * tokenizing stops early; any failure falls back to unstyled text.
   */
  private async highlightSides(request: TwoWayDiffRequest, highlighting: AbortController): Promise<SideHighlights> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        highlighting.abort();
        reject(new Error("Highlighting timed out."));
      }, this.options.highlightTimeoutMs ?? HIGHLIGHT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.highlightBothSides(request, highlighting.signal), timeout]);
    } catch (error) {
      this.options.log(`Syntax highlighting failed for ${request.title}; showing plain text. ${messageOf(error)}`);
      return [unstyledText(request.base.text), unstyledText(request.result.text)];
    } finally {
      clearTimeout(timer);
    }
  }

  private async highlightBothSides(request: TwoWayDiffRequest, signal: AbortSignal): Promise<SideHighlights> {
    const languageId = await languageOf(request.languageUri);
    const options: HighlightOptions = { signal, deadline: performance.now() + TOKENIZE_TIME_BUDGET_MS };
    const { highlighter } = this.options;
    return Promise.all([
      highlighter.highlight(request.base.text, languageId, options),
      highlighter.highlight(request.result.text, languageId, options),
    ]);
  }

  private render(
    webview: vscode.Webview,
    request: TwoWayDiffRequest,
    [baseHighlight, resultHighlight]: SideHighlights,
    page: number,
    adjacentFiles: AdjacentFiles | null,
  ): string {
    const { base, result } = request;
    const wordLevel = vscode.workspace.getConfiguration("jwDiffer").get<boolean>("wordLevelHighlighting", true);
    const diff = buildTwoWayDiff(base.text, result.text, { wordLevel });

    return new HtmlTwoWayDiffRenderer().render(
      { diff, baseText: base.text, resultText: result.text, baseHighlight, resultHighlight },
      {
        assets: {
          styleUri: this.mediaUri(webview, "diff.css"),
          scriptUri: this.mediaUri(webview, "diff.js"),
          cspSource: webview.cspSource,
        },
        geometryScriptUri: this.mediaUri(webview, "diffGeometry.js"),
        nonce: randomBytes(NONCE_BYTES).toString("base64"),
        cspSource: webview.cspSource,
        baseLabel: base.label,
        resultLabel: result.label,
        basePath: base.path,
        resultPath: result.path,
        title: request.title,
        page,
        ...(request.findAdjacentFiles === undefined ? {} : { fileList: adjacentFiles === null ? PENDING_NEIGHBOURS : neighboursOf(adjacentFiles) }),
        ...(request.startAt === undefined ? {} : { startAt: request.startAt }),
      },
    );
  }

  private mediaUri(webview: vscode.Webview, fileName: string): string {
    return webview.asWebviewUri(vscode.Uri.joinPath(this.options.mediaRoot, fileName)).toString();
  }

  /**
   * The webview is untrusted input; only `openNative`, `openAdjacentFile` and `openWorkingCopy` need an answer. A
   * message the page of an earlier comparison sent before it was replaced is dropped: it was meant for that comparison.
   */
  private async handleMessage(raw: unknown, open: OpenPanel): Promise<void> {
    const message = parsePanelMessage(raw);
    if (message === null || message.page !== open.page) {
      return;
    }
    const request = open.request;
    switch (message.type) {
      case "openNative":
        return this.openNative(request);
      case "openAdjacentFile":
        return this.openAdjacentFile(request, open.adjacentFiles, message.direction);
      case "openWorkingCopy":
        return this.openWorkingCopy(request, message.line);
    }
  }

  private async openNative(request: TwoWayDiffRequest): Promise<void> {
    try {
      await request.openNative();
    } catch (error) {
      this.options.log(`Opening the VS Code diff failed for ${request.title}. ${messageOf(error)}`);
      void vscode.window.showErrorMessage("jw-differ could not open the VS Code diff editor.");
    }
  }

  private async openAdjacentFile(request: TwoWayDiffRequest, adjacentFiles: AdjacentFiles | null, direction: FileDirection): Promise<void> {
    const openFile = adjacentFiles?.[direction];
    if (openFile === undefined) {
      return;
    }

    try {
      await openFile();
    } catch (error) {
      this.options.log(`Opening the ${direction} file after ${request.title} failed. ${messageOf(error)}`);
      void vscode.window.showErrorMessage(`jw-differ could not open the ${direction} file. ${messageOf(error)}`);
    }
  }

  /**
   * Opens the working file editable in a tab of its own, not a preview the next file opened would replace, with the
   * cursor where right-side line `line` is now: past later commits and unsaved edits, or the nearest line.
   */
  private async openWorkingCopy(request: TwoWayDiffRequest, line: number): Promise<void> {
    const uri = request.workingCopy;
    if (uri === undefined) {
      void vscode.window.showInformationMessage("The right side deletes this file, so it has no working copy.");
      return;
    }

    try {
      if (!(await isFile(uri.fsPath))) {
        void vscode.window.showInformationMessage(`${request.result.path} is not in the working copy; it may have been deleted or renamed.`);
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      const target = correspondingLine(request.result.text, document.getText(), line);
      const cursor = new vscode.Position(target, 0);
      await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(cursor, cursor) });
    } catch (error) {
      this.options.log(`Opening the working copy of ${request.title} failed. ${messageOf(error)}`);
      void vscode.window.showErrorMessage(`jw-differ could not open the working copy. ${messageOf(error)}`);
    }
  }
}

/**
 * Messages the diff webview sends, each with the number of the page that sent it; `ready` needs no answer. `line`
 * counts the right side's lines from 0.
 */
type PanelMessage = { readonly page: number } & (
  | { readonly type: "openNative" }
  | { readonly type: "openAdjacentFile"; readonly direction: FileDirection }
  | { readonly type: "openWorkingCopy"; readonly line: number }
);

function parsePanelMessage(raw: unknown): PanelMessage | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const { type, direction, line, page } = raw as {
    readonly type?: unknown;
    readonly direction?: unknown;
    readonly line?: unknown;
    readonly page?: unknown;
  };
  if (typeof page !== "number") {
    return null;
  }
  if (type === "openNative") {
    return { type, page };
  }
  if (type === "openWorkingCopy") {
    const isLine = typeof line === "number" && Number.isInteger(line) && line >= 0;
    return isLine ? { type, line, page } : null;
  }
  const isFileDirection = direction === "previous" || direction === "next";
  return type === "openAdjacentFile" && isFileDirection ? { type, direction, page } : null;
}

/**
 * The language VS Code gives the document at `uri`, or for a file that cannot open, as one deleted from the working
 * tree, the language it gives the file's name. VS Code exposes language detection only through an opened document;
 * the cache keeps such documents until closed.
 */
async function languageOf(uri: vscode.Uri): Promise<string> {
  try {
    return (await vscode.workspace.openTextDocument(uri)).languageId;
  } catch (error) {
    if (uri.scheme !== "file") {
      throw error;
    }
    return (await vscode.workspace.openTextDocument(uri.with({ scheme: FILE_NAME_LANGUAGE_SCHEME }))).languageId;
  }
}

function neighboursOf(adjacentFiles: AdjacentFiles): FileListNeighbours {
  return { hasPrevious: adjacentFiles.previous !== undefined, hasNext: adjacentFiles.next !== undefined };
}

/**
 * False for a missing path, or one that is no longer a file, such as a directory now in its place. Only the disk
 * counts: a file deleted while open with unsaved edits is gone too.
 */
async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
