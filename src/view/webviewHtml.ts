import { escapeHtml, renderGrid } from "./rowRenderer";
import type { MergeViewModel } from "./viewModel";

export interface PageOptions {
  readonly fileName: string;
  readonly showBasePane: boolean;
  readonly styleUri: string;
  readonly scriptUri: string;
  /** Value allowed by the webview's content security policy for local resources. */
  readonly cspSource: string;
}

/** Builds the full webview document for a merge view. */
export function renderMergePage(model: MergeViewModel, options: PageOptions): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${options.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link href="${options.styleUri}" rel="stylesheet">
<title>Merge: ${escapeHtml(options.fileName)}</title>
</head>
<body class="${options.showBasePane ? "" : "hide-base"}">
${renderToolbar(model, options)}
<div class="grid" id="grid">${renderGrid(model)}</div>
<script nonce="${nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}

function renderToolbar(model: MergeViewModel, options: PageOptions): string {
  const count = model.conflicts.length;
  const status = count === 0 ? "No conflicts remaining" : `${count} conflict${count === 1 ? "" : "s"}`;
  const firstConflict = model.conflicts[0];

  return `<header class="toolbar">
  <span class="file">${escapeHtml(options.fileName)}</span>
  <span class="status ${count === 0 ? "clean" : ""}">${status}</span>
  <span class="nav">
    <button id="prev" title="Previous conflict">↑ Prev</button>
    <button id="next" title="Next conflict">↓ Next</button>
  </span>
  <span class="headers">
    <span class="pane-title side-local">${escapeHtml(firstConflict?.localLabel || "Local")}</span>
    <span class="pane-title side-base">Base</span>
    <span class="pane-title side-remote">${escapeHtml(firstConflict?.remoteLabel || "Remote")}</span>
  </span>
</header>`;
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index++) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}
