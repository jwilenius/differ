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
}

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
  /** Change kind per line, or undefined for an unchanged line. */
  readonly lineKinds: ReadonlyMap<number, DiffBlockKind>;
  /** Empty ranges by the line they precede; the line count stands for "after the last line". */
  readonly gaps: ReadonlyMap<number, DiffBlockKind>;
  readonly words: ReadonlyMap<number, readonly WordSpan[]>;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/;
const LINE_SEPARATOR = "\n";

/**
 * Renders IntelliJ's side-by-side diff: base text and gutter, a connector
 * strip, then result gutter and text. Each pane keeps only its own lines; the
 * client script draws the ribbons and keeps the panes scrolled together.
 *
 * Client contract: `#diff[data-diff]` holds {@link TwoWayDiffClientData};
 * scrollers `#scroll-base` / `#scroll-result` contain one `.line` per text line
 * (all the same height); `svg#connectors` sits in `.strip`; buttons `#prev`,
 * `#next`, `#open-native`.
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
${renderToolbar(diff)}
<main class="diff" id="diff" data-diff="${escapeHtml(JSON.stringify(clientData(diff)))}">
${renderHeader("base", context.baseLabel, context.basePath)}
<div class="strip-header"></div>
${renderHeader("result", context.resultLabel, context.resultPath)}
${renderPane(basePane)}
<div class="strip"><svg id="connectors" aria-hidden="true"></svg></div>
${renderPane(resultPane)}
</main>
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

function renderToolbar(diff: TwoWayDiff): string {
  const count = diff.blocks.length;
  const status = count === 0 ? "No differences" : `${count} difference${count === 1 ? "" : "s"}`;

  return `<header class="toolbar">
  <span class="nav">
    <button id="prev" class="tool" title="Previous Difference (Shift+F7)" aria-label="Previous difference">↑</button>
    <button id="next" class="tool" title="Next Difference (F7)" aria-label="Next difference">↓</button>
  </span>
  <span class="status">${status}</span>
  <button id="open-native" class="tool text" title="Show this comparison in VS Code's built-in diff editor">Open in VS Code diff</button>
</header>`;
}

function renderHeader(side: PaneSide, label: string, filePath: string): string {
  return `<div class="pane-header pane-${side}"><b>${escapeHtml(label)}</b><span class="path">${escapeHtml(filePath)}</span></div>`;
}

function createPane(side: PaneSide, text: string, highlight: HighlightedText, diff: TwoWayDiff): PaneInput {
  const lineKinds = new Map<number, DiffBlockKind>();
  const gaps = new Map<number, DiffBlockKind>();
  const words = new Map<number, readonly WordSpan[]>();

  for (const block of diff.blocks) {
    const range: LineRange = block[side];
    if (range.start === range.end) {
      gaps.set(range.start, block.kind);
    }
    for (let line = range.start; line < range.end; line++) {
      lineKinds.set(line, block.kind);
    }
    for (const entry of side === "base" ? block.baseWords : block.resultWords) {
      words.set(entry.line, entry.spans);
    }
  }

  return { side, lines: text.split(LINE_SEPARATOR), highlight, lineKinds, gaps, words };
}

function renderPane(pane: PaneInput): string {
  const lines = pane.lines.map((text, index) => renderLine(pane, text, index)).join("");
  return `<div class="scroller pane-${pane.side}" id="scroll-${pane.side}"><div class="lines">${lines}</div></div>`;
}

/**
 * An empty range is drawn as a thin line on the top edge of the line it
 * precedes, or on the bottom edge of the last line when it follows all of them.
 * A trailing `\r` is dropped: the HTML parser would turn it into a line break.
 */
function renderLine(pane: PaneInput, rawText: string, index: number): string {
  const text = rawText.endsWith("\r") ? rawText.slice(0, -1) : rawText;
  const kind = pane.lineKinds.get(index);
  const gapBefore = pane.gaps.get(index);
  const gapAfter = index === pane.lines.length - 1 ? pane.gaps.get(pane.lines.length) : undefined;
  const classes = [
    "line",
    kind ? `chg-${kind}` : "",
    gapBefore ? `gap-before gap-${gapBefore}` : "",
    gapAfter ? `gap-after gap-${gapAfter}` : "",
  ].filter(Boolean).join(" ");
  const code = renderCode(text, pane.highlight.lines[index] ?? [], pane.words.get(index) ?? [], pane.side);
  const number = `<span class="num">${index + 1}</span>`;
  const content = pane.side === "base" ? `<span class="code">${code}</span>${number}` : `${number}<span class="code">${code}</span>`;

  return `<div class="${classes}">${content}</div>`;
}
