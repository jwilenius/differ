import type { WordSpan } from "../../core/types";
import { FontStyleFlag } from "../../model/syntaxTokens";
import type { SyntaxToken, TokenStyle } from "../../model/syntaxTokens";
import { escapeHtml } from "./webviewMarkup";

interface TokenRange {
  readonly start: number;
  readonly end: number;
  readonly styleIndex: number;
}

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly styleIndex: number | null;
  readonly isWord: boolean;
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{3,4}([0-9a-fA-F]{2}){0,2}$/;

/**
 * Token classes are per pane (`tk-<pane>-N`) because each pane has its own
 * style table. Only validated colours reach the stylesheet.
 */
export function renderTokenStyles(styles: readonly TokenStyle[], pane: string): string {
  return styles
    .map((style, index) => {
      const declarations = tokenDeclarations(style);
      return declarations.length === 0 ? "" : `.tk-${pane}-${index}{${declarations.join(";")}}`;
    })
    .join("");
}

function tokenDeclarations(style: TokenStyle): string[] {
  const declarations: string[] = [];
  if (style.color !== null && COLOR_PATTERN.test(style.color)) {
    declarations.push(`color:${style.color}`);
  }
  if (style.fontStyle & FontStyleFlag.italic) {
    declarations.push("font-style:italic");
  }
  if (style.fontStyle & FontStyleFlag.bold) {
    declarations.push("font-weight:bold");
  }
  const decorations = [
    style.fontStyle & FontStyleFlag.underline ? "underline" : "",
    style.fontStyle & FontStyleFlag.strikethrough ? "line-through" : "",
  ].filter(Boolean);
  if (decorations.length > 0) {
    declarations.push(`text-decoration:${decorations.join(" ")}`);
  }
  return declarations;
}

/** Splits tokens at word-span edges so every `.word` wraps whole token spans and the tags nest. */
export function renderCode(text: string, tokens: readonly SyntaxToken[], spans: readonly WordSpan[], pane: string): string {
  const parts: string[] = [];
  let isInWord = false;

  for (const segment of segmentLine(text.length, tokens, spans)) {
    if (segment.isWord !== isInWord) {
      parts.push(segment.isWord ? `<span class="word">` : "</span>");
      isInWord = segment.isWord;
    }
    const escaped = escapeHtml(text.slice(segment.start, segment.end));
    parts.push(segment.styleIndex === null ? escaped : `<span class="tk-${pane}-${segment.styleIndex}">${escaped}</span>`);
  }
  if (isInWord) {
    parts.push("</span>");
  }

  return parts.join("");
}

/** Cuts `[0, length)` at every token and span boundary; text the tokens do not cover is unstyled. */
function segmentLine(length: number, tokens: readonly SyntaxToken[], spans: readonly WordSpan[]): Segment[] {
  const tokenRanges = tokenOffsets(tokens);
  const clamp = (offset: number): number => Math.min(Math.max(offset, 0), length);
  const cuts = new Set<number>([0, length]);
  for (const range of [...tokenRanges, ...spans]) {
    cuts.add(clamp(range.start));
    cuts.add(clamp(range.end));
  }
  const sorted = [...cuts].sort((left, right) => left - right);

  // Tokens and spans are ordered and disjoint, so one cursor each walks them alongside the cuts.
  const segments: Segment[] = [];
  let tokenIndex = 0;
  let spanIndex = 0;
  for (let index = 0; index + 1 < sorted.length; index++) {
    const start = sorted[index];
    while (tokenIndex < tokenRanges.length && tokenRanges[tokenIndex].end <= start) {
      tokenIndex++;
    }
    while (spanIndex < spans.length && spans[spanIndex].end <= start) {
      spanIndex++;
    }
    const token = tokenRanges[tokenIndex];
    const span = spans[spanIndex];
    segments.push({
      start,
      end: sorted[index + 1],
      styleIndex: token && token.start <= start ? token.styleIndex : null,
      isWord: span !== undefined && span.start <= start,
    });
  }
  return segments;
}

function tokenOffsets(tokens: readonly SyntaxToken[]): TokenRange[] {
  const ranges: TokenRange[] = [];
  let offset = 0;
  for (const token of tokens) {
    ranges.push({ start: offset, end: offset + token.length, styleIndex: token.styleIndex });
    offset += token.length;
  }
  return ranges;
}
