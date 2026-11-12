/**
 * Syntax-highlighted text as plain serializable data, so a renderer can colour
 * code without knowing how it was tokenized. Produced from VS Code's TextMate
 * grammars and the active colour theme; a file with no grammar has one
 * unstyled token per line.
 */

/** Bit flags matching TextMate font styles. */
export const FontStyleFlag = {
  italic: 1,
  bold: 2,
  underline: 4,
  strikethrough: 8,
} as const;

/** One distinct look used by tokens; tokens refer to it by index. */
export interface TokenStyle {
  /** `#rgb`, `#rrggbb` or `#rrggbbaa`, or null for the editor's default foreground. */
  readonly color: string | null;
  /** Combination of {@link FontStyleFlag} values. */
  readonly fontStyle: number;
}

/** A run of characters sharing one style. Runs cover their line exactly, in order. */
export interface SyntaxToken {
  readonly length: number;
  /** Index into {@link HighlightedText.styles}. */
  readonly styleIndex: number;
}

export interface HighlightedText {
  readonly styles: readonly TokenStyle[];
  /** One entry per line of the source text (split on `\n`, a trailing `\r` kept in the text). */
  readonly lines: readonly (readonly SyntaxToken[])[];
}
