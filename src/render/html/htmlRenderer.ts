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
<body class="${context.showResultPane ? "" : "hide-result"}">
${renderToolbar(model, context)}
<div class="grid" id="grid">${renderGrid(model)}</div>
<script nonce="${nonce}" src="${this.assets.scriptUri}"></script>
</body>
</html>`;
  }
}

function renderToolbar(model: ResolutionViewModel, context: RenderContext): string {
  const count = model.conflicts.length;
  const status = count === 0
    ? "Ready to commit — no conflicts left"
    : `${count} unresolved conflict${count === 1 ? "" : "s"}`;

  return `<header class="toolbar">
  <span class="file">${escapeHtml(context.fileName)}</span>
  <span class="status ${count === 0 ? "clean" : ""}">${status}</span>
  ${renderSwapWarning(model)}
  <span class="nav">
    <button id="prev" title="Previous conflict">↑ Prev</button>
    <button id="next" title="Next conflict">↓ Next</button>
  </span>
  <span class="headers">
    <span class="pane-title pane-ours">${escapeHtml(model.ourLabel)}</span>
    <span class="pane-title pane-result">Will be committed</span>
    <span class="pane-title pane-theirs">${escapeHtml(model.theirLabel)}</span>
  </span>
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
