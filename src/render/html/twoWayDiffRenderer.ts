import type { WordSpan } from "../../core/types";
import type { HighlightedText } from "../../model/syntaxTokens";
import type { DiffBlockKind, LineRange, TwoWayDiff } from "../../model/twoWayDiff";
import { renderCode, renderTokenStyles } from "./codeMarkup";
import { escapeHtml, type WebviewAssets } from "./webviewMarkup";

export interface TwoWayDiffInput {
  readonly diff: TwoWayDiff;
  readonly baseText: string;
  readonly resultText: string;
  readonly baseHighlight: HighlightedText;
  readonly resultHighlight: HighlightedText;
}

export interface TwoWayDiffRenderContext {
  readonly assets: WebviewAssets;
  /** `diffGeometry.js`, which the client script needs loaded first. */
  readonly geometryScriptUri: string;
  readonly nonce: string;
  readonly cspSource: string;
  readonly baseLabel: string;
  readonly resultLabel: string;
  readonly basePath: string;
  readonly resultPath: string;
  readonly title: string;
  /** Numbers the page among those the panel showed; the client stamps it on every message it sends. */
  readonly page: number;
  /** The comparison's neighbouring files; absent when the diff has no file list, so F7 stops at either end. */
  readonly fileList?: FileListNeighbours;
  /** Defaults to the first change. */
  readonly startAt?: StartChange;
}

/** Published as JSON in `#diff[data-files]`: whether F7 past either end of the diff can open another file. */
export interface FileListNeighbours {
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

/** Which change a newly shown diff scrolls to: the last one when reached by stepping back from the next file. */
export type StartChange = "first" | "last";

/** Published as JSON in `#diff[data-diff]`; ranges are `[start, end)` line pairs. */
export interface TwoWayDiffClientData {
  readonly blocks: readonly {
    readonly kind: DiffBlockKind;
    readonly base: readonly [number, number];
    readonly result: readonly [number, number];
  }[];
  readonly baseLineCount: number;
  readonly resultLineCount: number;
}

type PaneSide = "base" | "result";

interface PaneInput {
  readonly side: PaneSide;
  readonly lines: readonly string[];
  readonly highlight: HighlightedText;
  /** The difference a line belongs to, or undefined for an unchanged line. */
  readonly lineDifferences: ReadonlyMap<number, LineDifference>;
  readonly differenceCount: number;
  /** Empty ranges by the line they precede; the line count stands for "after the last line". */
  readonly gaps: ReadonlyMap<number, DiffBlockKind>;
  readonly words: ReadonlyMap<number, readonly WordSpan[]>;
}

/** A changed line's block: its kind and 1-based number, as the status counts differences. */
interface LineDifference {
  readonly kind: DiffBlockKind;
  readonly number: number;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/;
const LINE_SEPARATOR = "\n";
const SIDE_NAMES: Readonly<Record<PaneSide, string>> = { base: "Left side", result: "Right side" };

/**
 * Renders IntelliJ's side-by-side diff: base text and gutter, a connector
 * strip, then result gutter and text. Each pane keeps only its own lines; the
 * client script draws the ribbons and keeps the panes scrolled together.
 *
 * Client contract: `#diff[data-diff]` holds {@link TwoWayDiffClientData};
 * `#diff[data-page]` the page's number, which every message carries back;
 * scrollers `#scroll-base` / `#scroll-result` contain one `.line` per text line
 * (all the same height); `svg#connectors` sits in `.strip`; buttons `#prev`,
 * `#next`, `#open-native`; `#diff[data-start-at]` is a {@link StartChange},
 * `#diff[data-files]` the optional {@link FileListNeighbours}; a
 * `{ type: "noAdjacentFile", page, direction }` message says a step that way
 * found no file to open, `direction` being `next` or `previous`, and
 * `{ type: "fileStepEnded", page, direction }` that one ended otherwise with
 * the page still shown; `#file-step`
 * is the live region showing the file-step hint. Each pane's `.lines` ends with
 * `#current-base` / `#current-result`, the hidden marker the client places over
 * the change navigated to. While there are differences, `#current-number` in the
 * status `#status` holds that change's 1-based number, which the client keeps up
 * to date along with the status's tooltip.
 */
export class HtmlTwoWayDiffRenderer {
  render(input: TwoWayDiffInput, context: TwoWayDiffRenderContext): string {
    if (!NONCE_PATTERN.test(context.nonce)) {
      throw new Error("Diff renderer needs a base64-style nonce of at least 16 characters");
    }
    const { assets, nonce } = context;
    const { diff } = input;
    const csp = [
      "default-src 'none'",
      `style-src ${context.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const basePane = createPane("base", input.baseText, input.baseHighlight, diff);
    const resultPane = createPane("result", input.resultText, input.resultHighlight, diff);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<link href="${escapeHtml(assets.styleUri)}" rel="stylesheet">
<style nonce="${nonce}">${renderTokenStyles(input.baseHighlight.styles, "base")}${renderTokenStyles(input.resultHighlight.styles, "result")}</style>
<title>${escapeHtml(context.title)}</title>
</head>
<body>
${renderToolbar(diff, context.startAt ?? "first")}
<main class="diff" id="diff" data-page="${context.page}" data-diff="${escapeHtml(JSON.stringify(clientData(diff)))}"${renderNavigationData(context)}>
${renderHeader("base", context.baseLabel, context.basePath)}
<div class="strip-header"></div>
${renderHeader("result", context.resultLabel, context.resultPath)}
${renderPane(basePane)}
<div class="strip"><svg id="connectors" aria-hidden="true"></svg></div>
${renderPane(resultPane)}
</main>
<div id="file-step" class="file-step" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${escapeHtml(context.geometryScriptUri)}"></script>
<script nonce="${nonce}" src="${escapeHtml(assets.scriptUri)}"></script>
</body>
</html>`;
  }
}

function clientData(diff: TwoWayDiff): TwoWayDiffClientData {
  return {
    blocks: diff.blocks.map((block) => ({
      kind: block.kind,
      base: [block.base.start, block.base.end] as const,
      result: [block.result.start, block.result.end] as const,
    })),
    baseLineCount: diff.baseLineCount,
    resultLineCount: diff.resultLineCount,
  };
}

function renderNavigationData(context: TwoWayDiffRenderContext): string {
  const startAt = ` data-start-at="${context.startAt ?? "first"}"`;
  const neighbours = context.fileList;
  const fileList = neighbours === undefined
    ? ""
    : ` data-files="${escapeHtml(JSON.stringify({ hasPrevious: neighbours.hasPrevious, hasNext: neighbours.hasNext }))}"`;
  return `${startAt}${fileList}`;
}

function renderToolbar(diff: TwoWayDiff, startAt: StartChange): string {
  return `<header class="toolbar">
  <span class="nav">
    <button id="prev" class="tool" title="Previous Difference (Shift+F7)" aria-label="Previous difference">↑</button>
    <button id="next" class="tool" title="Next Difference (F7)" aria-label="Next difference">↓</button>
  </span>
  <span id="status" class="status" role="status" aria-live="polite" title="${describeStatus(diff.blocks.length, startAt)}">${renderStatus(diff.blocks.length, startAt)}</span>
  <button id="open-native" class="tool text" title="Show this comparison in VS Code's built-in diff editor">Open in VS Code diff</button>
</header>`;
}

/** "No differences", or "1 / 7 differences" numbering the change the client marks on opening. */
function renderStatus(count: number, startAt: StartChange): string {
  if (count === 0) {
    return "No differences";
  }
  const current = startAt === "last" ? count : 1;
  return `<span id="current-number">${current}</span> / ${count} difference${count === 1 ? "" : "s"}`;
}

/** The status's tooltip; `diff.js` words it alike once it moves the number. */
function describeStatus(count: number, startAt: StartChange): string {
  if (count === 0) {
    return "The two sides have no line differences";
  }
  const current = startAt === "last" ? count : 1;
  return `Difference ${current} of ${count} is marked; F7 / Shift+F7 or ↓/↑ go to the next / previous`;
}

/** The tooltip names the side and shows the full path, which the header may cut short. */
function renderHeader(side: PaneSide, label: string, filePath: string): string {
  const title = `${SIDE_NAMES[side]}: ${label}\n${filePath}`;
  return `<div class="pane-header pane-${side}" title="${escapeHtml(title)}"><b>${escapeHtml(label)}</b><span class="path">${escapeHtml(filePath)}</span></div>`;
}

function createPane(side: PaneSide, text: string, highlight: HighlightedText, diff: TwoWayDiff): PaneInput {
  const lineDifferences = new Map<number, LineDifference>();
  const gaps = new Map<number, DiffBlockKind>();
  const words = new Map<number, readonly WordSpan[]>();

  diff.blocks.forEach((block, index) => {
    const range: LineRange = block[side];
    if (range.start === range.end) {
      gaps.set(range.start, block.kind);
    }
    for (let line = range.start; line < range.end; line++) {
      lineDifferences.set(line, { kind: block.kind, number: index + 1 });
    }
    for (const entry of side === "base" ? block.baseWords : block.resultWords) {
      words.set(entry.line, entry.spans);
    }
  });

  return { side, lines: text.split(LINE_SEPARATOR), highlight, lineDifferences, differenceCount: diff.blocks.length, gaps, words };
}

function renderPane(pane: PaneInput): string {
  const lines = pane.lines.map((text, index) => renderLine(pane, text, index)).join("");
  const marker = `<div class="current-change" id="current-${pane.side}" hidden aria-hidden="true"></div>`;
  return `<div class="scroller pane-${pane.side}" id="scroll-${pane.side}"><div class="lines">${lines}${marker}</div></div>`;
}

/**
 * An empty range is drawn as a thin line on the top edge of the line it
 * precedes, or on the bottom edge of the last line when it follows all of them.
 * A trailing `\r` is dropped: the HTML parser would turn it into a line break.
 */
function renderLine(pane: PaneInput, rawText: string, index: number): string {
  const text = rawText.endsWith("\r") ? rawText.slice(0, -1) : rawText;
  const difference = pane.lineDifferences.get(index);
  const kind = difference?.kind;
  const gapBefore = pane.gaps.get(index);
  const gapAfter = index === pane.lines.length - 1 ? pane.gaps.get(pane.lines.length) : undefined;
  const classes = [
    "line",
    kind ? `chg-${kind}` : "",
    gapBefore ? `gap-before gap-${gapBefore}` : "",
    gapAfter ? `gap-after gap-${gapAfter}` : "",
  ].filter(Boolean).join(" ");
  const code = renderCode(text, pane.highlight.lines[index] ?? [], pane.words.get(index) ?? [], pane.side);
  // diff.css draws the number, which keeps it out of the page text that VS Code's find widget searches.
  const number = `<span class="num" data-number="${index + 1}" title="${describeLine(index + 1, difference, pane.differenceCount)}"></span>`;
  const content = pane.side === "base" ? `<span class="code">${code}</span>${number}` : `${number}<span class="code">${code}</span>`;

  return `<div class="${classes}">${content}</div>`;
}

/** A line number's tooltip: the line, and the difference it is part of. */
function describeLine(number: number, difference: LineDifference | undefined, differenceCount: number): string {
  return difference === undefined
    ? `Line ${number}`
    : `Line ${number}, in difference ${difference.number} of ${differenceCount} (${difference.kind})`;
}
