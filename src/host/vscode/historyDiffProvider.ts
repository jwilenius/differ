import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { HistorySnapshotError } from "../../git/gitComparisonRepository";
import { describeResolvedBase } from "../../model/historyLabels";
import { describeSelectedChanges } from "../../model/historyWorkingChanges";
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

/** Shown instead of a file of a comparison whose snapshot has been released. */
export const COMPARISON_CHANGED_MESSAGE = "This comparison has changed — open the file again from the updated list.";

/**
 * Files read in each direction for a file step once the panel shows a file: past this many files that open no diff,
 * the panel offers no step that way, so a step is never offered only after a long run of large files.
 */
const STEP_READ_LIMIT = 20;

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
 * neighbouring files of the same comparison, in the order the history panel lists them, while its snapshot is held.
 */
export class HistoryDiffProvider implements vscode.TextDocumentContentProvider, HistoryFileOpener {
  private readonly documents = new Map<string, string>();
  /** Document IDs an open panel still refers to. */
  private readonly pinned = new Set<string>();
  private readonly shutdown = new AbortController();
  /** Aborted when a later open or file step replaces the one in progress. */
  private opening = new AbortController();
  private readonly closeSubscription: vscode.Disposable;
  private readonly openedFileChanges = new vscode.EventEmitter<void>();
  private opened: OpenedFile | null = null;
  readonly onDidChangeOpenedFile = this.openedFileChanges.event;

  /** `log` receives the reason a file step could not be read, other than a released snapshot. */
  constructor(
    private readonly panels: Pick<TwoWayDiffPanels, "open">,
    private readonly log: (message: string) => void,
  ) {
    this.closeSubscription = vscode.workspace.onDidCloseTextDocument((document) => this.forgetUnpinned(document.uri));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const documentId = documentIdOf(uri);
    return (documentId === null ? undefined : this.documents.get(documentId)) ?? UNAVAILABLE_DOCUMENT_TEXT;
  }

  /**
   * Starts both side reads in the same tick, so both take their snapshot leases before a selection change can release
   * the snapshot. Rejects, opening nothing, when the snapshot is already gone or a read fails. Resolves, opening
   * nothing, once a later open or file step replaces this one before it shows.
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
    const opening = this.startOpening(checkout, comparison);
    const contents = await this.read(opening, file);
    if (contents !== undefined) {
      await this.show(opening, file, contents, startAt);
    }
  }

  /** Cancels the open in progress, whose reads and display are no longer wanted. */
  private startOpening(checkout: HistoryCheckout, comparison: ReadyResult, left?: ReadFile): Opening {
    this.opening.abort();
    this.opening = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, this.opening.signal]);
    return { checkout, comparison, signal, ...(left === undefined ? {} : { left }) };
  }

  /** Both sides of `file`, read in the same tick; undefined once the opening is cancelled, even if a read failed. */
  private async read(opening: Opening, file: ComparisonFile): Promise<SideContents | undefined> {
    const { checkout, comparison, signal } = opening;
    try {
      const [base, result] = await Promise.all(
        (["base", "result"] as const).map((side) => checkout.repository.readFile(comparison.snapshotId, file.id, side, signal)),
      );
      return signal.aborted ? undefined : { base, result };
    } catch (error) {
      if (signal.aborted) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Opens text in the configured viewer, or an explanation of content that is not text. A panel shows the file at once
   * and asks for its steps afterwards.
   */
  private async show(opening: Opening, file: ComparisonFile, contents: SideContents, startAt: StartChange): Promise<void> {
    const { checkout, comparison } = opening;
    const viewer = vscode.workspace.getConfiguration("jwDiffer").get<string>(DIFF_VIEWER_SETTING, "intellij");
    const isNative = viewer === "native";

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
    try {
      if (isNative) {
        await openNativeDiff(sides, title);
      } else {
        await this.openPanel(comparison, file, title, sides, {
          startAt,
          findAdjacentFiles: this.adjacentFileFinder(opening, { file, contents }),
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
      ...(navigation.findAdjacentFiles === undefined ? {} : { findAdjacentFiles: navigation.findAdjacentFiles }),
      ...(navigation.workingCopy === undefined ? {} : { workingCopy: navigation.workingCopy }),
    });
  }

  /**
   * Finds the steps from the shown file, which the panel asks for once it shows it and stops once the tab moves on;
   * undefined when the file is not in the list.
   */
  private adjacentFileFinder(opening: Opening, shown: ReadFile): ((signal: AbortSignal) => Promise<AdjacentFiles>) | undefined {
    const index = opening.comparison.files.findIndex((candidate) => candidate.id === shown.file.id);
    if (index === -1) {
      return undefined;
    }
    return (signal) => this.adjacentFiles({ ...opening, signal: AbortSignal.any([this.shutdown.signal, signal]) }, shown, index);
  }

  /**
   * Steps to the nearest files before and after the shown file, at `index` in list order, that read as text on both
   * sides, so the panel offers only the steps that open a diff. Both directions read at once; none once `finding`'s
   * signal aborts. A step shows the contents read here, but only while the snapshot is held: once
   * released, the list has moved on.
   */
  private async adjacentFiles(finding: Opening, shown: ReadFile, index: number): Promise<AdjacentFiles> {
    const { checkout, comparison } = finding;
    const { files } = comparison;
    const [previous, next] = await Promise.all([
      this.firstTextFile(finding, files.slice(0, index).reverse().filter(hasTextChange)),
      this.firstTextFile(finding, files.slice(index + 1).filter(hasTextChange)),
    ]);
    const stepTo = (neighbour: ReadFile, startAt: StartChange) => async (): Promise<void> => {
      if (!checkout.repository.hasSnapshot(comparison.snapshotId)) {
        void vscode.window.showInformationMessage(COMPARISON_CHANGED_MESSAGE);
        return;
      }
      await this.show(this.startOpening(checkout, comparison, shown), neighbour.file, neighbour.contents, startAt);
    };
    if (finding.signal.aborted) {
      return {};
    }
    return {
      ...(previous === undefined ? {} : { previous: stepTo(previous, "last") }),
      ...(next === undefined ? {} : { next: stepTo(next, "first") }),
    };
  }

  /**
   * The first of `candidates` that reads as text on both sides: a file too large or not UTF-8 opens no diff. Undefined
   * when none of the first `STEP_READ_LIMIT` does, or once a read fails, as after the snapshot is released: the list
   * still opens each file and reports why it cannot. A failure other than a released snapshot is logged.
   */
  private async firstTextFile(opening: Opening, candidates: readonly ComparisonFile[]): Promise<ReadFile | undefined> {
    for (const file of candidates.slice(0, STEP_READ_LIMIT)) {
      let contents: SideContents | undefined;
      try {
        contents = opening.left?.file.id === file.id ? opening.left.contents : await this.read(opening, file);
      } catch (error) {
        if (!(error instanceof HistorySnapshotError)) {
          const reason = error instanceof Error ? error.message : String(error);
          this.log(`Could not read ${(file.result ?? file.base)!.path} for a file step: ${reason}`);
        }
        return undefined;
      }
      if (contents === undefined) {
        return undefined;
      }
      if (isText(contents)) {
        return { file, contents };
      }
    }
    return undefined;
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
  return describeSelectedChanges(comparison.orderedOids);
}

/**
 * Whether a file step can land on a change in `file`. Binary files open outside the diff panel, and a rename or mode
 * change keeping the content has no change to show; both still open from the list.
 */
function hasTextChange(file: ComparisonFile): boolean {
  const isContentChanged = file.base?.blob !== file.result?.blob;
  return file.contentKind !== "binary" && isContentChanged;
}

/** One open or file step: the comparison it shows a file of. */
interface Opening {
  readonly checkout: HistoryCheckout;
  readonly comparison: ReadyResult;
  /**
   * Aborted when a later opening replaces this one or the provider is disposed; for a neighbour search, instead once its
   * tab moves on or the provider is disposed.
   */
  readonly signal: AbortSignal;
  /** The file a step leaves, already read, so finding the steps from the file it opens does not read it again. */
  readonly left?: ReadFile;
}

interface PanelNavigation {
  readonly startAt: StartChange;
  readonly findAdjacentFiles: ((signal: AbortSignal) => Promise<AdjacentFiles>) | undefined;
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

/** A file of the comparison and both its sides as read. */
interface ReadFile {
  readonly file: ComparisonFile;
  readonly contents: SideContents;
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
