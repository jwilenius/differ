import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { describeResolvedBase } from "../../model/historyLabels";
import type {
  ComparisonFile,
  ComparisonFileSide,
  FileContentResult,
  FileSide,
  HistoryRepository,
  OpenedFile,
  ReadyResult,
} from "../../model/historyTypes";
import type { StartChange } from "../../render/html/twoWayDiffRenderer";
import type { AdjacentFiles, TwoWayDiffPanels } from "./twoWayDiffPanel";

export const HISTORY_DOCUMENT_SCHEME = "jw-differ-history";

/** Setting choosing how text changes open: `intellij` (jw-differ's side-by-side panel, default) or `native` (`vscode.diff`). */
export const DIFF_VIEWER_SETTING = "historyDiffViewer";

/** Shown for a URI this provider never issued or has already forgotten; nothing is ever read from disk or Git. */
export const UNAVAILABLE_DOCUMENT_TEXT = "This jw-differ history document is no longer available. Open the file again from the history panel.\n";

/** A repository's history and the working tree it belongs to, whose files F4 in the diff panel opens. */
export interface HistoryCheckout {
  readonly repository: HistoryRepository;
  /** The working tree's top-level directory. */
  readonly root: string;
}

/**
 * Opens one changed file of a ready comparison and reports which one the diff panel shows; implemented by
 * `HistoryDiffProvider`.
 */
export interface HistoryFileOpener {
  openFile(checkout: HistoryCheckout, comparison: ReadyResult, file: ComparisonFile): Promise<void>;
  /** The file jw-differ's diff panel shows; null while it shows none. A native diff is not tracked. */
  readonly openedFile: OpenedFile | null;
  readonly onDidChangeOpenedFile: vscode.Event<void>;
}

/**
 * Serves immutable `jw-differ-history` documents and opens them in jw-differ's diff panel or VS Code's diff editor. Every
 * opening reads both sides once, caches the text under fresh opaque document IDs and never reads again, so an open
 * editor keeps showing the comparison it was opened from after the snapshot is released or the selection changes.
 * URIs only address this cache; their paths are display data. Documents shown by an open panel stay cached until the
 * panel closes, so its "Open in VS Code diff" keeps working after VS Code closes them. A panel can step to the
 * neighbouring files of the same comparison, in the order the history panel lists them.
 */
export class HistoryDiffProvider implements vscode.TextDocumentContentProvider, HistoryFileOpener {
  private readonly documents = new Map<string, string>();
  /** Document IDs an open panel still refers to. */
  private readonly pinned = new Set<string>();
  private readonly shutdown = new AbortController();
  private readonly closeSubscription: vscode.Disposable;
  private readonly openedFileChanges = new vscode.EventEmitter<void>();
  private opened: OpenedFile | null = null;
  readonly onDidChangeOpenedFile = this.openedFileChanges.event;

  constructor(private readonly panels: Pick<TwoWayDiffPanels, "open">) {
    this.closeSubscription = vscode.workspace.onDidCloseTextDocument((document) => this.forgetUnpinned(document.uri));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const documentId = documentIdOf(uri);
    return (documentId === null ? undefined : this.documents.get(documentId)) ?? UNAVAILABLE_DOCUMENT_TEXT;
  }

  /**
   * Starts both side reads in the same tick, so both take their snapshot leases before a selection change can release
   * the snapshot. Rejects, opening nothing, when the snapshot is already gone or a read fails.
   */
  openFile(checkout: HistoryCheckout, comparison: ReadyResult, file: ComparisonFile): Promise<void> {
    return this.openFileAt(checkout, comparison, file, "first");
  }

  get openedFile(): OpenedFile | null {
    return this.opened;
  }

  /** Cancels pending reads and forgets every cached document. */
  dispose(): void {
    this.shutdown.abort();
    this.closeSubscription.dispose();
    this.openedFileChanges.dispose();
    this.documents.clear();
    this.pinned.clear();
  }

  /** Like `openFile`; a panel showing the file starts at `startAt`. */
  private async openFileAt(checkout: HistoryCheckout, comparison: ReadyResult, file: ComparisonFile, startAt: StartChange): Promise<void> {
    const contents = await this.read(checkout.repository, comparison, file);
    if (contents !== undefined) {
      await this.show(checkout, comparison, file, contents, startAt);
    }
  }

  /**
   * Opens the first of `candidates` that reads as text on both sides. A file too large or not UTF-8 would open outside
   * the panel and end the stepping there, so it is passed over; when no candidate reads as text, the first one's
   * explanation opens.
   */
  private async stepTo(checkout: HistoryCheckout, comparison: ReadyResult, candidates: readonly ComparisonFile[], startAt: StartChange): Promise<void> {
    let firstNonText: { readonly file: ComparisonFile; readonly contents: SideContents } | undefined;
    for (const file of candidates) {
      const contents = await this.read(checkout.repository, comparison, file);
      if (contents === undefined) {
        return;
      }
      if (isText(contents)) {
        await this.show(checkout, comparison, file, contents, startAt);
        return;
      }
      firstNonText ??= { file, contents };
    }
    if (firstNonText !== undefined) {
      await this.show(checkout, comparison, firstNonText.file, firstNonText.contents, startAt);
    }
  }

  /** Both sides of `file`, read in the same tick; undefined once the provider is disposed. */
  private async read(repository: HistoryRepository, comparison: ReadyResult, file: ComparisonFile): Promise<SideContents | undefined> {
    const signal = this.shutdown.signal;
    const [base, result] = await Promise.all(
      (["base", "result"] as const).map((side) => repository.readFile(comparison.snapshotId, file.id, side, signal)),
    );
    return signal.aborted ? undefined : { base, result };
  }

  /** Opens text in the configured viewer, or an explanation of content that is not text. */
  private async show(checkout: HistoryCheckout, comparison: ReadyResult, file: ComparisonFile, contents: SideContents, startAt: StartChange): Promise<void> {
    const title = diffTitle(comparison, file);
    const { base, result } = contents;
    if (base.kind !== "text" || result.kind !== "text") {
      await this.openExplanation(this.store(file, "result", describeNonText(title, file, contents), " (not text)"));
      return;
    }

    const sides: CachedSides = {
      base: { uri: this.store(file, "base", base.text), text: base.text },
      result: { uri: this.store(file, "result", result.text), text: result.text },
    };
    const viewer = vscode.workspace.getConfiguration("jwDiffer").get<string>(DIFF_VIEWER_SETTING, "intellij");
    try {
      if (viewer === "native") {
        await openNativeDiff(sides, title);
      } else {
        await this.openPanel(comparison, file, title, sides, {
          startAt,
          adjacentFiles: this.adjacentFiles(checkout, comparison, file),
          workingCopy: file.result === null ? undefined : vscode.Uri.joinPath(vscode.Uri.file(checkout.root), file.result.path),
        });
      }
    } catch (error) {
      this.forget(sides.base.uri);
      this.forget(sides.result.uri);
      throw error;
    }
  }

  private async openExplanation(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
    } catch (error) {
      this.forget(uri);
      throw error;
    }
  }

  /**
   * The panel pins both documents and reports `file` as opened while it shows them; its language comes from the
   * result document, or the base one for a deletion.
   */
  private async openPanel(comparison: ReadyResult, file: ComparisonFile, title: string, sides: CachedSides, navigation: PanelNavigation): Promise<void> {
    const { base, result } = sides;
    const openedFile: OpenedFile = { snapshotId: comparison.snapshotId, fileId: file.id };
    this.pin(base.uri);
    this.pin(result.uri);

    await this.panels.open({
      title,
      base: { ...base, label: describeResolvedBase(comparison.base), path: file.base?.path ?? "" },
      result: { ...result, label: describeSelection(comparison), path: file.result?.path ?? "" },
      languageUri: file.result === null ? base.uri : result.uri,
      openNative: () => openNativeDiff(sides, title),
      shown: () => this.setOpenedFile(openedFile),
      release: () => {
        this.release(base.uri);
        this.release(result.uri);
        if (this.opened === openedFile) {
          this.setOpenedFile(null);
        }
      },
      startAt: navigation.startAt,
      ...(navigation.adjacentFiles === undefined ? {} : { adjacentFiles: navigation.adjacentFiles }),
      ...(navigation.workingCopy === undefined ? {} : { workingCopy: navigation.workingCopy }),
    });
  }

  /**
   * Steps to the nearest files before and after `file` in list order that have a text change to land on; undefined
   * when `file` is not in the list.
   */
  private adjacentFiles(checkout: HistoryCheckout, comparison: ReadyResult, file: ComparisonFile): AdjacentFiles | undefined {
    const { files } = comparison;
    const index = files.findIndex((candidate) => candidate.id === file.id);
    if (index === -1) {
      return undefined;
    }
    const previous = files.slice(0, index).reverse().filter(hasTextChange);
    const next = files.slice(index + 1).filter(hasTextChange);
    return {
      ...(previous.length === 0 ? {} : { previous: () => this.stepTo(checkout, comparison, previous, "last") }),
      ...(next.length === 0 ? {} : { next: () => this.stepTo(checkout, comparison, next, "first") }),
    };
  }

  private setOpenedFile(file: OpenedFile | null): void {
    this.opened = file;
    this.openedFileChanges.fire();
  }

  private store(file: ComparisonFile, side: FileSide, text: string, suffix = ""): vscode.Uri {
    const documentId = randomUUID();
    this.documents.set(documentId, text);
    const displayPath = (file[side] ?? file[otherSide(side)])!.path;
    return vscode.Uri.from({ scheme: HISTORY_DOCUMENT_SCHEME, path: `/${documentId}/${displayPath}${suffix}` });
  }

  private pin(uri: vscode.Uri): void {
    const documentId = documentIdOf(uri);
    if (documentId !== null) {
      this.pinned.add(documentId);
    }
  }

  /** Unpins and forgets the document unless VS Code still has it open; its close event forgets it later. */
  private release(uri: vscode.Uri): void {
    const documentId = documentIdOf(uri);
    if (documentId === null) {
      return;
    }
    this.pinned.delete(documentId);
    const isOpen = vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString());
    if (!isOpen) {
      this.documents.delete(documentId);
    }
  }

  private forgetUnpinned(uri: vscode.Uri): void {
    const documentId = documentIdOf(uri);
    if (documentId !== null && !this.pinned.has(documentId)) {
      this.documents.delete(documentId);
    }
  }

  private forget(uri: vscode.Uri): void {
    const documentId = documentIdOf(uri);
    if (documentId !== null) {
      this.pinned.delete(documentId);
      this.documents.delete(documentId);
    }
  }
}

function documentIdOf(uri: vscode.Uri): string | null {
  if (uri.scheme !== HISTORY_DOCUMENT_SCHEME) {
    return null;
  }
  const [, documentId] = uri.path.split("/");
  return documentId || null;
}

function openNativeDiff(sides: CachedSides, title: string): Thenable<unknown> {
  return vscode.commands.executeCommand("vscode.diff", sides.base.uri, sides.result.uri, title, { preview: true });
}

function otherSide(side: FileSide): FileSide {
  return side === "base" ? "result" : "base";
}

/** File, then the base and selected-commit count the content was read from. */
function diffTitle(comparison: ReadyResult, file: ComparisonFile): string {
  const isRename = file.base !== null && file.result !== null && file.base.path !== file.result.path;
  const fileLabel = isRename ? `${file.base!.path} → ${file.result!.path}` : (file.result ?? file.base)!.path;
  return `${fileLabel} (${describeResolvedBase(comparison.base)} ↔ ${describeSelection(comparison)})`;
}

function describeSelection(comparison: ReadyResult): string {
  const count = comparison.orderedOids.length;
  return `${count} selected commit${count === 1 ? "" : "s"}`;
}

/**
 * Whether a file step can land on a change in `file`. Binary files open outside the diff panel, and a rename or mode
 * change keeping the content has no change to show; both still open from the list.
 */
function hasTextChange(file: ComparisonFile): boolean {
  const isContentChanged = file.base?.blob !== file.result?.blob;
  return file.contentKind !== "binary" && isContentChanged;
}

interface PanelNavigation {
  readonly startAt: StartChange;
  readonly adjacentFiles: AdjacentFiles | undefined;
  /** The file F4 opens; undefined for a deletion. */
  readonly workingCopy: vscode.Uri | undefined;
}

interface CachedDocument {
  readonly uri: vscode.Uri;
  readonly text: string;
}

interface CachedSides {
  readonly base: CachedDocument;
  readonly result: CachedDocument;
}

interface SideContents {
  readonly base: FileContentResult;
  readonly result: FileContentResult;
}

function isText(contents: SideContents): boolean {
  return contents.base.kind === "text" && contents.result.kind === "text";
}

function describeNonText(title: string, file: ComparisonFile, contents: SideContents): string {
  return [
    "jw-differ does not show this change as text.",
    "",
    `Comparison: ${title}`,
    `Status: ${file.status}`,
    `Base:   ${describeSide(file.base, contents.base)}`,
    `Result: ${describeSide(file.result, contents.result)}`,
    "",
  ].join("\n");
}

function describeSide(side: ComparisonFileSide | null, content: FileContentResult): string {
  if (side === null) {
    return "absent";
  }
  const detail = content.kind === "text"
    ? `text, ${Buffer.byteLength(content.text, "utf8")} bytes`
    : `${content.reason}, ${content.sizeBytes} bytes — ${content.explanation}`;
  return `${side.path} (mode ${side.mode}, blob ${side.blob}): ${detail}`;
}
