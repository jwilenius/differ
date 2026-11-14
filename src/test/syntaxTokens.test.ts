import { describe, expect, it } from "vitest";
import { rebaseStyles, type HighlightedText, type TokenStyle } from "../model/syntaxTokens";

const PLAIN: TokenStyle = { color: null, fontStyle: 0 };
const KEYWORD: TokenStyle = { color: "#569cd6", fontStyle: 0 };
const COMMENT: TokenStyle = { color: "#6a9955", fontStyle: 1 };

describe("rebaseStyles", () => {
  it("keeps the indexes a table already gives and appends the styles it lacks", () => {
    const highlight: HighlightedText = {
      styles: [PLAIN, COMMENT, KEYWORD],
      lines: [[{ length: 2, styleIndex: 1 }], [{ length: 3, styleIndex: 2 }, { length: 1, styleIndex: 0 }]],
    };

    const rebased = rebaseStyles(highlight, [PLAIN, KEYWORD]);

    expect(rebased.styles).toEqual([PLAIN, KEYWORD, COMMENT]);
    expect(rebased.lines).toEqual([[{ length: 2, styleIndex: 2 }], [{ length: 3, styleIndex: 1 }, { length: 1, styleIndex: 0 }]]);
  });
});
