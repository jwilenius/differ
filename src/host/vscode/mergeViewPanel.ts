import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { markResolved } from "../../git/gitConflictedFiles";
import { readMergeSources, type UnmergeableReason } from "../../git/gitMergeSources";
import { TOKENIZE_TIME_BUDGET_MS, unstyledText } from "../../highlight/textMateHighlighter";
import {
  acceptSide,
  applyNonConflicting,
  applySide,
  editLine,
  ignoreSide,
  joinWithPrevious,
  replaceLines,
  splitLine,
  startMerge,
  tallyMerge,
  type MergeState,
  type MergeTally,
} from "../../model/mergeSession";
import { firstResultChange, MergeHistory, type ResultPosition } from "../../model/mergeHistory";
import { describeMerge } from "../../model/mergeView";
import { rebaseStyles, type HighlightedText } from "../../model/syntaxTokens";
import { renderTokenStyles } from "../../render/html/codeMarkup";
import { HtmlMergeViewRenderer, mergeClientData, resultLineMarkup, type MergeViewRenderContext } from "../../render/html/mergeViewRenderer";
import { escapeHtml } from "../../render/html/webviewMarkup";
import {
  parseMergeMessage,
  type LineEdit,
  type MergeHighlightUpdate,
  type MergeLayoutUpdate,
  type MergeMessage,
  type MergeRedrawNotice,
} from "./mergeMessages";
import { writeMergeResult } from "./mergeResultWriter";
import { ShownMergeResult } from "./shownMergeResult";
import type { TextHighlighter } from "./twoWayDiffPanel";

const VIEW_TYPE = "jwDiffer.mergeView";
const NONCE_BYTES = 16;
/** How long a render waits for highlighting before showing plain text. */
const HIGHLIGHT_TIMEOUT_MS = 3_000;
/** How long a colour theme redraw waits for the page to send the edit it holds back. */
const HELD_BACK_EDIT_TIMEOUT_MS = 500;
/** The `shownPage` while no page takes messages: pages are numbered from 1. */
const NO_PAGE = 0;

/** Why the merge view cannot merge a file, as its page says. */
const UNMERGEABLE_EXPLANATIONS: Readonly<Record<UnmergeableReason, string>> = {
  noMergeableConflict: `This file has no conflict jw-differ can merge: it is not conflicted, one side deleted it,
or a side is a symbolic link or submodule.`,
  binary: "A version of this file in the conflict is binary, so jw-differ cannot merge it as text.",
  invalidEncoding: `A version of this file in the conflict is not UTF-8 text, as a Latin-1 or Windows-1252 file is.
jw-differ merges UTF-8 text only; merging it would corrupt its other characters.`,
};

export interface MergeViewPanelOptions {
  /** Read only while the panel opens: VS Code may close the document while the panel stays open. */
  readonly document: vscode.TextDocument;
  readonly mediaRoot: vscode.Uri;
  readonly highlighter: TextHighlighter;
  readonly log: (message: string) => void;
  readonly onDispose: () => void;
}

/** What git says about the merge, read once when the panel opens. */
interface MergeContext {
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly isSidesSwapped: boolean;
  readonly eol: string;
  readonly hasByteOrderMark: boolean;
  readonly languageId: string;
}

/**
 * Hosts IntelliJ's merge dialog for one conflicted file. The result lives in
 * memory, starting from the common ancestor; Apply writes it to the file and
 * stages it once every change has been processed.
 */
export class MergeViewPanel {
  private readonly panel: vscode.WebviewPanel;
  /** The panel's title, which never changes; reading it from the panel throws once the panel is closed, as a log after an await may find. */
  private readonly title: string;
  /** The conflicted file, which outlives the document captured at open. */
  private readonly uri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private context: MergeContext | null = null;
  private state: MergeState | null = null;
  /** Side highlighting never changes until the colour theme does. */
  private sideHighlights: Promise<readonly [HighlightedText, HighlightedText]> | null = null;
  /** Counts renders so a slow one never overwrites a newer page; each page carries its render's number. */
  private renderGeneration = 0;
  /** The number of the page the webview shows; messages a replaced page sent are dropped. */
  private shownPage = NO_PAGE;
  private shownResult: ShownMergeResult | null = null;
  /**
   * Called once the shown page answers `redrawReady`, having sent the edit it held back, with where its caret was;
   * each wait removes its own when it ends. Any answer resumes every wait: it comes from the shown page, as answers
   * from replaced pages are dropped, and that page answers only once it took no more edits.
   */
  private readonly heldBackEditWaiters = new Set<(caret: ResultPosition | null) => void>();
  /** Calls off the result highlighting still running for an earlier edit. */
  private refreshAbort: AbortController | null = null;
  private readonly history = new MergeHistory();
  /** Apply writes the merge as it was asked for, so the merge takes no other message until it is done. */
  private isApplying = false;
  /** Closing the panel while it loads or renders is not an error; its webview just takes no more content. */
  private isDisposed = false;

  private constructor(private readonly options: MergeViewPanelOptions) {
    this.uri = options.document.uri;
    this.title = `Merge: ${path.basename(options.document.uri.fsPath)}`;
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      this.title,
      vscode.ViewColumn.Active,
      { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true, localResourceRoots: [options.mediaRoot] },
    );
    this.panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    vscode.window.onDidChangeActiveColorTheme(() => this.onColorsChanged(), undefined, this.disposables);
  }

  /** Closes the panel again when loading fails, so no blank panel is left behind. */
  static async create(options: MergeViewPanelOptions): Promise<MergeViewPanel> {
    const view = new MergeViewPanel(options);
    try {
      await view.load();
    } catch (error) {
      view.panel.dispose();
      throw error;
    }
    return view;
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  private async load(): Promise<void> {
    const { document } = this.options;
    const sources = await readMergeSources(document.uri.fsPath);
    if (this.isDisposed) {
      return;
    }
    if ("unmergeable" in sources) {
      this.panel.webview.html = renderUnavailable(path.basename(document.uri.fsPath), sources.unmergeable);
      return;
    }
    this.context = {
      leftLabel: sources.ourLabel,
      rightLabel: sources.theirLabel,
      isSidesSwapped: sources.isSidesSwapped,
      eol: document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n",
      hasByteOrderMark: sources.hasByteOrderMark,
      languageId: document.languageId,
    };
    this.state = startMerge(normalizeEol(sources.base ?? ""), normalizeEol(sources.ours), normalizeEol(sources.theirs));
    await this.render();
  }

  /** `caret` is where the new page puts the caret, as after an undo or redo or where the page it replaces had it. */
  private async render(caret: ResultPosition | null = null): Promise<void> {
    const { state, context } = this;
    if (state === null || context === null) {
      return;
    }
    const generation = ++this.renderGeneration;
    this.sideHighlights ??= this.highlightSides(state, context.languageId);
    const [[leftHighlight, rightHighlight], resultHighlight] = await Promise.all([
      this.sideHighlights,
      this.highlight(state.resultLines.join("\n"), context.languageId),
    ]);
    const isSuperseded = generation !== this.renderGeneration;
    if (isSuperseded || this.isDisposed) {
      return;
    }
    // An edit typed while highlighting ran is already on the page, so the new page must show it too.
    if (this.state !== state) {
      return this.render(caret);
    }
    const input = {
      state,
      chunks: describeMerge(state, { wordLevel: isWordLevel() }),
      tally: tallyMerge(state),
      leftHighlight,
      rightHighlight,
      resultHighlight,
    };
    this.panel.webview.html = new HtmlMergeViewRenderer().render(input, this.renderContext(context, generation, caret));
    this.shownPage = generation;
    this.shownResult = new ShownMergeResult(resultLineMarkup(input), resultHighlight.styles);
  }

  /**
   * Redraws a page the user may be typing in, as a colour theme change does: the page first sends the edit it
   * holds back, which a new page drawn before it arrived would drop. Other redraws need not wait: a page sends
   * its edit before the action that redraws it, and everything a page sends after a rejected message is dropped.
   * Not while Apply runs: its page takes no edits, Apply drops the page's answer, and Apply closes or redraws the
   * page once done.
   *
   * An action's redraw may replace the page while it is told; that page was never told and may be typed in. When
   * its render began after this redraw was asked for, it already shows what the redraw is for, so it stays;
   * otherwise it is told in turn before it is replaced.
   */
  private async redrawTypingPage(): Promise<void> {
    const lastOutdatedRender = this.renderGeneration;
    for (;;) {
      if (this.isApplying) {
        return;
      }
      const toldPage = this.shownPage;
      const caret = await this.takeHeldBackEdit();
      // Apply may have begun while the page was told: it drops the answer and closes or redraws the page itself.
      if (this.isApplying || this.shownPage > lastOutdatedRender) {
        return;
      }
      if (this.shownPage === toldPage) {
        return this.render(caret);
      }
    }
  }

  /**
   * Tells the shown page it is being replaced: it sends the edit it holds back, takes no more and answers
   * `redrawReady` with where its caret was, which the new page takes. A page that does not answer in time, as one
   * still loading cannot, is replaced anyway, with no caret.
   */
  private async takeHeldBackEdit(): Promise<ResultPosition | null> {
    if (this.shownPage === NO_PAGE) {
      return null;
    }
    let resume = (_caret: ResultPosition | null): void => undefined;
    const answered = new Promise<ResultPosition | null>((resolve) => (resume = resolve));
    this.heldBackEditWaiters.add(resume);
    const timer = setTimeout(() => resume(null), HELD_BACK_EDIT_TIMEOUT_MS);
    const notice: MergeRedrawNotice = { type: "redrawing", page: this.shownPage };
    void this.panel.webview.postMessage(notice);
    const caret = await answered;
    clearTimeout(timer);
    this.heldBackEditWaiters.delete(resume);
    return caret;
  }

  private renderContext(context: MergeContext, page: number, caret: ResultPosition | null): MergeViewRenderContext {
    const { webview } = this.panel;
    return {
      nonce: randomBytes(NONCE_BYTES).toString("base64"),
      cspSource: webview.cspSource,
      title: this.title,
      styleUris: [this.mediaUri("diff.css"), this.mediaUri("merge.css")],
      scriptUris: [this.mediaUri("diffGeometry.js"), this.mediaUri("mergeLines.js"), this.mediaUri("overviewRuler.js"), this.mediaUri("merge.js")],
      leftLabel: context.leftLabel,
      rightLabel: context.rightLabel,
      resultPath: vscode.workspace.asRelativePath(this.uri),
      isSidesSwapped: context.isSidesSwapped,
      page,
      caret,
    };
  }

  private async highlightSides(state: MergeState, languageId: string): Promise<readonly [HighlightedText, HighlightedText]> {
    return Promise.all([this.highlight(state.leftLines.join("\n"), languageId), this.highlight(state.rightLines.join("\n"), languageId)]);
  }

  /** Falls back to plain text when highlighting fails or outlasts its timeout. */
  private async highlight(text: string, languageId: string): Promise<HighlightedText> {
    return (await this.tryHighlight(text, languageId)) ?? unstyledText(text);
  }

  /** Null when highlighting fails, outlasts its timeout or is called off through `signal`; only a failure is logged. */
  private async tryHighlight(text: string, languageId: string, signal?: AbortSignal): Promise<HighlightedText | null> {
    const abort = new AbortController();
    signal?.addEventListener("abort", () => abort.abort());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error("Highlighting timed out."));
      }, HIGHLIGHT_TIMEOUT_MS);
    });
    const options = { signal: abort.signal, deadline: performance.now() + TOKENIZE_TIME_BUDGET_MS };
    try {
      return await Promise.race([this.options.highlighter.highlight(text, languageId, options), timeout]);
    } catch (error) {
      if (!signal?.aborted) {
        this.options.log(`Syntax highlighting failed for ${this.title}; showing plain text. ${messageOf(error)}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private onColorsChanged(): void {
    this.sideHighlights = null;
    void this.redrawTypingPage();
  }

  private mediaUri(fileName: string): string {
    return this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.options.mediaRoot, fileName)).toString();
  }

  /**
   * The webview is untrusted input: anything but a well-formed message is dropped. The page then
   * gets redrawn, since a dropped edit, or one naming lines the result lacks, means the page shows
   * a result the merge does not hold. A message from a replaced page is dropped without a redraw:
   * it arrives after the page now shown was drawn without it, so dropping it keeps the two agreeing.
   * The page counts as replaced from the dropped message on: what it sends next may name lines the
   * dropped edit added or removed on the page.
   */
  private async handleMessage(value: unknown): Promise<void> {
    if (this.state === null) {
      return;
    }
    if (this.isApplying) {
      this.options.log(`Dropped a merge message sent while the result of ${this.title} is applied.`);
      return;
    }
    const message = parseMergeMessage(value);
    if (message !== null && message.page !== this.shownPage) {
      this.options.log(`Dropped a ${message.type} message from a replaced merge page for ${this.title}.`);
      return;
    }
    if (message === null || !fitsResult(this.state, message)) {
      this.options.log(`Dropped a merge message the result cannot take for ${this.title}; redrawing the page.`);
      this.shownPage = NO_PAGE;
      return this.render();
    }
    try {
      await this.dispatch(message, this.state);
    } catch (error) {
      this.options.log(`Merge action ${message.type} failed for ${this.title}. ${messageOf(error)}`);
      void vscode.window.showErrorMessage(`jw-differ could not complete the merge action. ${messageOf(error)}`);
    }
  }

  private async dispatch(message: MergeMessage, state: MergeState): Promise<void> {
    if (message.type === "redrawReady") {
      // The page sent the edit it held back before answering, so the merge holds that edit by now.
      this.heldBackEditWaiters.forEach((resume) => resume(message.caret));
      return;
    }
    if (message.type === "apply") {
      return this.applyResult(state);
    }
    if (message.type === "cancel") {
      return this.cancel(state);
    }
    if (message.type === "undo" || message.type === "redo") {
      this.state = message.type === "undo" ? this.history.undo(state) : this.history.redo(state);
      // The page stops taking edits once it asks, so it is redrawn even when there was nothing to undo.
      return this.render(firstResultChange(state.resultLines, this.state.resultLines));
    }
    this.state = nextState(state, message);
    this.history.record(state, this.state);
    // Result edits are already on the page; rebuilding it would lose keystrokes, the caret and undo.
    if (isLineEdit(message)) {
      this.shownResult?.noteEdit(message);
      void this.refreshResultHighlight(message.page, this.state);
    }
    if (message.type === "editLine") {
      return;
    }
    if (message.type === "splitLine" || message.type === "joinWithPrevious" || message.type === "replaceLines") {
      return this.postLayout(message.page, message.seq, this.state);
    }
    // The page stops taking edits once it sends a resolving action, so it is redrawn even when nothing changed.
    await this.render();
  }

  /** Tells the page where the chunks moved, so it can redraw tints and ribbons around the lines it added or removed itself. */
  private async postLayout(page: number, seq: number, state: MergeState): Promise<void> {
    const data = mergeClientData(state, describeMerge(state, { wordLevel: false }));
    const update: MergeLayoutUpdate = { type: "layout", page, seq, data };
    await this.panel.webview.postMessage(update);
  }

  /**
   * Highlights the edited result and sends the page the lines whose markup changed; an edit made meanwhile calls
   * the run off. A failed run sends nothing, leaving the page's colours as they were rather than plain.
   */
  private async refreshResultHighlight(page: number, state: MergeState): Promise<void> {
    const { context, shownResult } = this;
    if (context === null || shownResult === null) {
      return;
    }
    this.refreshAbort?.abort();
    const abort = new AbortController();
    this.refreshAbort = abort;
    const highlight = await this.tryHighlight(state.resultLines.join("\n"), context.languageId, abort.signal);
    if (highlight === null || abort.signal.aborted || this.state !== state || this.shownResult !== shownResult || this.isDisposed) {
      return;
    }
    const resultHighlight = rebaseStyles(highlight, shownResult.styles);
    const markup = resultLineMarkup({ state, chunks: describeMerge(state, { wordLevel: isWordLevel() }), resultHighlight });
    const lines = shownResult.update(markup, resultHighlight.styles);
    const update: MergeHighlightUpdate = { type: "highlight", page, seq: shownResult.seq, styles: renderTokenStyles(resultHighlight.styles, "result"), lines };
    await this.panel.webview.postMessage(update);
  }

  /** Applies the result and closes the panel; the page stops taking edits once it asks, so it is redrawn when the result was not applied. */
  private async applyResult(state: MergeState): Promise<void> {
    this.isApplying = true;
    try {
      if (await this.writeAndStage(state)) {
        this.panel.dispose();
      }
    } finally {
      this.isApplying = false;
      if (!this.isDisposed) {
        void this.render();
      }
    }
  }

  /** Writes the result to the file and saves it; stages it only when nothing is left unresolved. False when it was not written. */
  private async writeAndStage(state: MergeState): Promise<boolean> {
    const tally = tallyMerge(state);
    const isComplete = tally.changes === 0 && tally.conflicts === 0;
    if (!isComplete && !(await confirm(`${describeTally(tally)} Apply the result anyway? The file will not be staged.`, "Apply"))) {
      return false;
    }
    const text = state.resultLines.join(this.context?.eol ?? "\n");
    if (!(await writeMergeResult(this.uri, text, this.context?.hasByteOrderMark ?? false))) {
      return false;
    }
    if (isComplete) {
      await this.stage(this.uri.fsPath);
    }
    return true;
  }

  private async stage(filePath: string): Promise<void> {
    try {
      await markResolved(filePath);
    } catch (error) {
      this.options.log(`git add failed for ${filePath}: ${messageOf(error)}`);
      void vscode.window.showWarningMessage(`jw-differ wrote ${path.basename(filePath)} but could not stage it.`);
    }
  }

  private async cancel(state: MergeState): Promise<void> {
    if (state.isModified && !(await confirm("Discard the changes made in the merge view?", "Discard"))) {
      return;
    }
    this.panel.dispose();
  }

  private dispose(): void {
    this.isDisposed = true;
    this.options.onDispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

/** The merge state after a resolving or editing message. */
function nextState(state: MergeState, message: Exclude<MergeMessage, { type: "apply" | "cancel" | "undo" | "redo" | "redrawReady" }>): MergeState {
  switch (message.type) {
    case "applySide":
      return applySide(state, message.chunk, message.side);
    case "ignoreSide":
      return ignoreSide(state, message.chunk, message.side);
    case "applyNonConflicting":
      return applyNonConflicting(state, message.scope);
    case "acceptSide":
      return acceptSide(state, message.side);
    case "editLine":
      return editLine(state, message.line, message.text);
    case "splitLine":
      return splitLine(state, message.line, message.offset);
    case "joinWithPrevious":
      return joinWithPrevious(state, message.line);
    case "replaceLines":
      return replaceLines(state, message.line, message.count, message.lines);
  }
}

function isLineEdit(message: MergeMessage): message is LineEdit & { readonly page: number } {
  return message.type === "editLine" || message.type === "splitLine" || message.type === "joinWithPrevious" || message.type === "replaceLines";
}

function isWordLevel(): boolean {
  return vscode.workspace.getConfiguration("jwDiffer").get<boolean>("wordLevelHighlighting", true);
}

/** Whether an edit names lines the result has; any other message fits. */
function fitsResult(state: MergeState, message: MergeMessage): boolean {
  switch (message.type) {
    case "editLine":
    case "splitLine":
      return message.line < state.resultLines.length;
    case "replaceLines":
      return message.line + message.count <= state.resultLines.length;
    case "joinWithPrevious":
      return message.line > 0 && message.line < state.resultLines.length;
    default:
      return true;
  }
}

function describeTally(tally: MergeTally): string {
  const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
  return `${plural(tally.changes, "change")} and ${plural(tally.conflicts, "conflict")} are unresolved.`;
}

async function confirm(message: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
}

/**
 * Git's stages may use CRLF; the merge works on bare lines and Apply restores the document's line ending. A lone
 * CR breaks the line too, as in VS Code's editor: a page cannot show one inside a line, nor send it back.
 */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function renderUnavailable(fileName: string, reason: UnmergeableReason): string {
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
</head><body style="font-family: sans-serif; padding: 2rem;">
<h3>jw-differ cannot merge ${escapeHtml(fileName)}</h3>
<p>jw-differ reads both sides and their common ancestor from git's conflict stages.
${UNMERGEABLE_EXPLANATIONS[reason]} Resolve it with git instead.</p>
</body></html>`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
