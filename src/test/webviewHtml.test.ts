import { describe, expect, it } from "vitest";
import { renderMergePage } from "../view/webviewHtml";
import { buildMergeView } from "../view/viewModel";

const model = buildMergeView(
  ["<<<<<<< HEAD", "mine", "||||||| base", "orig", "=======", "theirs", ">>>>>>> feature"].join("\n"),
  { wordLevelHighlighting: true },
);

const options = {
  fileName: "conflicted.ts",
  showBasePane: true,
  styleUri: "vscode-resource://main.css",
  scriptUri: "vscode-resource://main.js",
  cspSource: "vscode-resource:",
};

describe("renderMergePage", () => {
  it("locks the script down to a per-render nonce", () => {
    const html = renderMergePage(model, options);

    const nonce = html.match(/script-src 'nonce-([A-Za-z0-9]{32})'/)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${nonce}"`);
  });

  it("uses a different nonce on each render", () => {
    const first = renderMergePage(model, options).match(/nonce-([A-Za-z0-9]{32})/)?.[1];
    const second = renderMergePage(model, options).match(/nonce-([A-Za-z0-9]{32})/)?.[1];

    expect(first).not.toBe(second);
  });

  it("shows the branch labels as pane titles", () => {
    const html = renderMergePage(model, options);

    expect(html).toContain('class="pane-title side-local">HEAD<');
    expect(html).toContain('class="pane-title side-remote">feature<');
  });

  it("reports the conflict count", () => {
    expect(renderMergePage(model, options)).toContain("1 conflict<");
  });

  it("marks a clean file as resolved", () => {
    const clean = buildMergeView("a\nb", { wordLevelHighlighting: true });

    expect(renderMergePage(clean, options)).toContain("No conflicts remaining");
  });

  it("hides the base pane when the setting is off", () => {
    const html = renderMergePage(model, { ...options, showBasePane: false });

    expect(html).toContain('<body class="hide-base">');
  });
});
