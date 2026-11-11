import type { ResolutionViewModel } from "../../model/resolutionView";
import type { MergeRenderer, RenderContext } from "../renderer";
import { escapeHtml, renderGrid } from "./rowMarkup";

export interface WebviewAssets {
  readonly styleUri: string;
  readonly scriptUri: string;
  /** Value the webview's content security policy allows local resources from. */
  readonly cspSource: string;
}

/** Renders the merge model as a self-contained webview document. */
export class HtmlMergeRenderer implements MergeRenderer<string> {
  constructor(private readonly assets: WebviewAssets) {}

  render(model: ResolutionViewModel, context: RenderContext): string {
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${this.assets.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link href="${this.assets.styleUri}" rel="stylesheet">
<title>Merge: ${escapeHtml(context.fileName)}</title>
</head>
<body class="${context.showResultPane ? "" : "hide-result"}"${focusAttributes(context.focus)}>
${renderToolbar(model, context)}
<div class="grid" id="grid">${renderGrid(model)}</div>
<script nonce="${nonce}" src="${this.assets.scriptUri}"></script>
</body>
</html>`;
  }
}

/** Hands the caret position to the client script so typing survives a rebuild. */
function focusAttributes(focus: RenderContext["focus"]): string {
  if (!focus) {
    return "";
  }
  return ` data-focus-line="${focus.line}" data-focus-offset="${focus.offset}"`;
}

/** IntelliJ's merge toolbar: conflict navigation on the left, the tally on the right. */
function renderToolbar(model: ResolutionViewModel, context: RenderContext): string {
  const count = model.conflicts.length;
  const status = count === 0
    ? "Ready to commit — no conflicts left"
    : `${count} conflict${count === 1 ? "" : "s"}`;

  return `<header class="toolbar">
  <span class="nav">
    <button id="prev" class="tool" title="Previous conflict (Shift+F7)">↑</button>
    <button id="next" class="tool" title="Next conflict (F7)">↓</button>
  </span>
  <span class="file">${escapeHtml(context.fileName)}</span>
  ${renderSwapWarning(model)}
  <span class="status ${count === 0 ? "clean" : ""}">${status}</span>
</header>`;
}

/** Rebase and cherry-pick reverse git's sense of the two sides; say so plainly. */
function renderSwapWarning(model: ResolutionViewModel): string {
  if (!model.isSidesSwapped) {
    return "";
  }
  return `<span class="warning" title="During a rebase or cherry-pick git replays your commits onto the other branch, so the sides are reversed">⚠ replay in progress — sides are reversed</span>`;
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index++) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}
