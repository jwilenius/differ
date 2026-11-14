import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { markResolved } from "../../git/gitConflictedFiles";
import { readMergeSources } from "../../git/gitMergeSources";
import { TOKENIZE_TIME_BUDGET_MS, unstyledText } from "../../highlight/textMateHighlighter";
import {
  acceptSide,
  applyNonConflicting,
  applySide,
  editLine,
  ignoreSide,
  joinWithPrevious,
  splitLine,
  startMerge,
  tallyMerge,
  type MergeState,
  type MergeTally,
} from "../../model/mergeSession";
import { describeMerge } from "../../model/mergeView";
import type { HighlightedText } from "../../model/syntaxTokens";
import { HtmlMergeViewRenderer, type FocusRequest, type MergeViewRenderContext } from "../../render/html/mergeViewRenderer";
import { escapeHtml } from "../../render/html/webviewMarkup";
import { parseMergeMessage, type MergeMessage } from "./mergeMessages";
import type { TextHighlighter } from "./twoWayDiffPanel";

const VIEW_TYPE = "differ.mergeView";
const NONCE_BYTES = 16;
/** How long a render waits for highlighting before showing plain text. */
const HIGHLIGHT_TIMEOUT_MS = 3_000;

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
  readonly languageId: string;
}

/**
 * Hosts IntelliJ's merge dialog for one conflicted file. The result lives in
 * memory, starting from the common ancestor; Apply writes it to the file and
 * stages it once every change has been processed.
 */
export class MergeViewPanel {
  private readonly panel: vscode.WebviewPanel;
  /** The conflicted file, which outlives the document captured at open. */
  private readonly uri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private context: MergeContext | null = null;
  private state: MergeState | null = null;
  /** Side highlighting never changes until the colour theme does. */
  private sideHighlights: Promise<readonly [HighlightedText, HighlightedText]> | null = null;
  /** Counts renders so a slow one never overwrites a newer page. */
  private renderGeneration = 0;
  /** Closing the panel while it loads or renders is not an error; its webview just takes no more content. */
  private isDisposed = false;

  private constructor(private readonly options: MergeViewPanelOptions) {
    this.uri = options.document.uri;
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Merge: ${path.basename(options.document.uri.fsPath)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [options.mediaRoot] },
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
    const sources = await readMergeSources(document.uri.fsPath, document.getText());
    if (this.isDisposed) {
      return;
    }
    if (!sources) {
      this.panel.webview.html = renderUnavailable(path.basename(document.uri.fsPath));
      return;
    }
    this.context = {
      leftLabel: sources.ourLabel,
      rightLabel: sources.theirLabel,
      isSidesSwapped: sources.isSidesSwapped,
      eol: document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n",
      languageId: document.languageId,
    };
    this.state = startMerge(normalizeEol(sources.base ?? ""), normalizeEol(sources.ours), normalizeEol(sources.theirs));
    await this.render(null);
  }

  private async render(focus: FocusRequest | null): Promise<void> {
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
    const wordLevel = vscode.workspace.getConfiguration("differ").get<boolean>("wordLevelHighlighting", true);
    const input = {
      state,
      chunks: describeMerge(state, { wordLevel }),
      tally: tallyMerge(state),
      leftHighlight,
      rightHighlight,
      resultHighlight,
    };
    this.panel.webview.html = new HtmlMergeViewRenderer().render(input, this.renderContext(context, focus));
  }

  private renderContext(context: MergeContext, focus: FocusRequest | null): MergeViewRenderContext {
    const { webview } = this.panel;
    return {
      nonce: randomBytes(NONCE_BYTES).toString("base64"),
      cspSource: webview.cspSource,
      title: this.panel.title,
      styleUris: [this.mediaUri("diff.css"), this.mediaUri("merge.css")],
      scriptUris: [this.mediaUri("diffGeometry.js"), this.mediaUri("merge.js")],
      leftLabel: context.leftLabel,
      rightLabel: context.rightLabel,
      resultPath: vscode.workspace.asRelativePath(this.uri),
      isSidesSwapped: context.isSidesSwapped,
      focus,
    };
  }

  private async highlightSides(state: MergeState, languageId: string): Promise<readonly [HighlightedText, HighlightedText]> {
    return Promise.all([this.highlight(state.leftLines.join("\n"), languageId), this.highlight(state.rightLines.join("\n"), languageId)]);
  }

  /** Falls back to plain text when highlighting fails or outlasts its timeout. */
  private async highlight(text: string, languageId: string): Promise<HighlightedText> {
    const abort = new AbortController();
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
      this.options.log(`Syntax highlighting failed for ${this.panel.title}; showing plain text. ${messageOf(error)}`);
      return unstyledText(text);
    } finally {
      clearTimeout(timer);
    }
  }

  private onColorsChanged(): void {
    this.sideHighlights = null;
    void this.render(null);
  }

  private mediaUri(fileName: string): string {
    return this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.options.mediaRoot, fileName)).toString();
  }

  /**
   * The webview is untrusted input: anything but a well-formed message is dropped. The page then
   * gets redrawn, since a dropped edit, or one naming lines the result lacks, means the page shows
   * a result the merge does not hold.
   */
  private async handleMessage(value: unknown): Promise<void> {
    if (this.state === null) {
      return;
    }
    const message = parseMergeMessage(value);
    if (message === null || !fitsResult(this.state, message)) {
      this.options.log(`Dropped a merge message the result cannot take for ${this.panel.title}; redrawing the page.`);
      return this.render(null);
    }
    try {
      await this.dispatch(message, this.state);
    } catch (error) {
      this.options.log(`Merge action ${message.type} failed for ${this.panel.title}. ${messageOf(error)}`);
      void vscode.window.showErrorMessage(`Differ could not complete the merge action. ${messageOf(error)}`);
    }
  }

  private async dispatch(message: MergeMessage, state: MergeState): Promise<void> {
    if (message.type === "apply") {
      return this.applyResult(state);
    }
    if (message.type === "cancel") {
      return this.cancel(state);
    }
    this.state = nextState(state, message);
    if (this.state !== state) {
      await this.render("focus" in message ? message.focus : null);
    }
  }

  /** Writes the result to the file and saves it; stages it only when nothing is left unresolved. */
  private async applyResult(state: MergeState): Promise<void> {
    const tally = tallyMerge(state);
    const isComplete = tally.changes === 0 && tally.conflicts === 0;
    if (!isComplete && !(await confirm(`${describeTally(tally)} Apply the result anyway? The file will not be staged.`, "Apply"))) {
      return;
    }
    // The document captured at open may have been closed since; a closed one can no longer be saved.
    const document = await vscode.workspace.openTextDocument(this.uri);
    if (await isSymbolicLink(document.uri.fsPath)) {
      const reason = "it is a symbolic link, and saving would change the file it points to";
      void vscode.window.showErrorMessage(`Differ will not write ${path.basename(document.uri.fsPath)}: ${reason}.`);
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const wholeDocument = new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
    edit.replace(document.uri, wholeDocument, state.resultLines.join(this.context?.eol ?? "\n"));
    const isWritten = (await vscode.workspace.applyEdit(edit)) && (await document.save());
    if (!isWritten) {
      void vscode.window.showErrorMessage(`Differ could not write ${path.basename(document.uri.fsPath)}.`);
      return;
    }
    if (isComplete) {
      await this.stage(document.uri.fsPath);
    }
    this.panel.dispose();
  }

  private async stage(filePath: string): Promise<void> {
    try {
      await markResolved(filePath);
    } catch (error) {
      this.options.log(`git add failed for ${filePath}: ${messageOf(error)}`);
      void vscode.window.showWarningMessage(`Differ wrote ${path.basename(filePath)} but could not stage it.`);
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
function nextState(state: MergeState, message: Exclude<MergeMessage, { type: "apply" | "cancel" }>): MergeState {
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
  }
}

/** Whether an edit names lines the result has; any other message fits. */
function fitsResult(state: MergeState, message: MergeMessage): boolean {
  switch (message.type) {
    case "editLine":
    case "splitLine":
      return message.line < state.resultLines.length;
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

/** A missing file is not a link: saving creates it. */
async function isSymbolicLink(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(filePath)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Git's stages may use CRLF; the merge works on bare lines and Apply restores the document's line ending. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function renderUnavailable(fileName: string): string {
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
</head><body style="font-family: sans-serif; padding: 2rem;">
<h3>Differ cannot merge ${escapeHtml(fileName)}</h3>
<p>Differ reads both sides and their common ancestor from git's conflict stages.
This file has no conflict Differ can merge: it is not conflicted, one side deleted it,
or a side is a symbolic link or submodule. Resolve it with git instead.</p>
</body></html>`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
