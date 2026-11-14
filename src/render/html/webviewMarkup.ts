/** Where a webview page loads its stylesheet and script from. */
export interface WebviewAssets {
  readonly styleUri: string;
  readonly scriptUri: string;
  /** Value the webview's content security policy allows local resources from. */
  readonly cspSource: string;
}

/** Escapes text for HTML content and double-quoted attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
