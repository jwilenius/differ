import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { describeResolvedBase } from "../../model/historyLabels";
import type {
  ComparisonFile,
  ComparisonFileSide,
  FileContentResult,
  FileSide,
  HistoryRepository,
  ReadyResult,
} from "../../model/historyTypes";
import type { TwoWayDiffPanels } from "./twoWayDiffPanel";

export const HISTORY_DOCUMENT_SCHEME = "differ-history";

/** Setting choosing how text changes open: `intellij` (Differ's side-by-side panel, default) or `native` (`vscode.diff`). */
export const DIFF_VIEWER_SETTING = "historyDiffViewer";

/** Shown for a URI this provider never issued or has already forgotten; nothing is ever read from disk or Git. */
export const UNAVAILABLE_DOCUMENT_TEXT = "This Differ history document is no longer available. Open the file again from the history panel.\n";

/** Opens one changed file of a ready comparison; implemented by `HistoryDiffProvider`. */
export interface HistoryFileOpener {
  openFile(repository: HistoryRepository, comparison: ReadyResult, file: ComparisonFile): Promise<void>;
}

/**
 * Serves immutable `differ-history` documents and opens them in Differ's diff panel or VS Code's diff editor. Every
 * opening reads both sides once, caches the text under fresh opaque document IDs and never reads again, so an open
 * editor keeps showing the comparison it was opened from after the snapshot is released or the selection changes.
 * URIs only address this cache; their paths are display data. Documents shown by an open panel stay cached until the
 * panel closes, so its "Open in VS Code diff" keeps working after VS Code closes them.
 */
export class HistoryDiffProvider implements vscode.TextDocumentContentProvider, HistoryFileOpener {
  private readonly documents = new Map<string, string>();
  /** Document IDs an open panel still refers to. */
  private readonly pinned = new Set<string>();
  private readonly shutdown = new AbortController();
  private readonly closeSubscription: vscode.Disposable;

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
  async openFile(repository: HistoryRepository, comparison: ReadyResult, file: ComparisonFile): Promise<void> {
    const signal = this.shutdown.signal;
    const [base, result] = await Promise.all(
      (["base", "result"] as const).map((side) => repository.readFile(comparison.snapshotId, file.id, side, signal)),
    );
    if (signal.aborted) {
      return;
    }

    const title = diffTitle(comparison, file);
    if (base.kind !== "text" || result.kind !== "text") {
      await this.openExplanation(this.store(file, "result", describeNonText(title, file, { base, result }), " (not text)"));
      return;
    }

    const sides: CachedSides = {
      base: { uri: this.store(file, "base", base.text), text: base.text },
      result: { uri: this.store(file, "result", result.text), text: result.text },
    };
    const viewer = vscode.workspace.getConfiguration("differ").get<string>(DIFF_VIEWER_SETTING, "intellij");
    try {
      if (viewer === "native") {
        await openNativeDiff(sides, title);
      } else {
        await this.openPanel(comparison, file, title, sides);
      }
    } catch (error) {
      this.forget(sides.base.uri);
      this.forget(sides.result.uri);
      throw error;
    }
  }

  /** Cancels pending reads and forgets every cached document. */
  dispose(): void {
    this.shutdown.abort();
    this.closeSubscription.dispose();
    this.documents.clear();
    this.pinned.clear();
  }

  private async openExplanation(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
    } catch (error) {
      this.forget(uri);
      throw error;
    }
  }

  /** The panel pins both documents; its language comes from the result document, or the base one for a deletion. */
  private async openPanel(comparison: ReadyResult, file: ComparisonFile, title: string, sides: CachedSides): Promise<void> {
    const { base, result } = sides;
    this.pin(base.uri);
    this.pin(result.uri);

    await this.panels.open({
      title,
      base: { ...base, label: describeResolvedBase(comparison.base), path: file.base?.path ?? "" },
      result: { ...result, label: describeSelection(comparison), path: file.result?.path ?? "" },
      languageUri: file.result === null ? base.uri : result.uri,
      openNative: () => openNativeDiff(sides, title),
      release: () => {
        this.release(base.uri);
        this.release(result.uri);
      },
    });
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

function describeNonText(title: string, file: ComparisonFile, contents: SideContents): string {
  return [
    "Differ does not show this change as text.",
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
