import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";

const MATCH_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "media", "fuzzyMatch.js"), "utf8");

interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/** The pure functions `fuzzyMatch.js` exposes as its one global, `fuzzyMatch`. */
interface FuzzyMatch {
  foldForMatch(text: string): string;
  isFuzzyMatch(foldedQuery: string, foldedText: string): boolean;
  fuzzyMatchRanges(foldedQuery: string, text: string): MatchRange[] | null;
}

function loadFuzzyMatch(): FuzzyMatch {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(MATCH_SOURCE, context);
  return context.fuzzyMatch as FuzzyMatch;
}

const fuzzy = loadFuzzyMatch();

function matches(query: string, text: string): boolean {
  return fuzzy.isFuzzyMatch(fuzzy.foldForMatch(query), fuzzy.foldForMatch(text));
}

/** `text` with each marked range in brackets. */
function marked(query: string, text: string): string | null {
  const ranges = fuzzy.fuzzyMatchRanges(fuzzy.foldForMatch(query), text);
  if (ranges === null) {
    return null;
  }
  let result = "";
  let offset = 0;
  for (const range of ranges) {
    result += `${text.slice(offset, range.start)}[${text.slice(range.start, range.end)}]`;
    offset = range.end;
  }
  return result + text.slice(offset);
}

describe("fuzzy match", () => {
  it("defines one global, fuzzyMatch, and nothing else", () => {
    const context: Record<string, unknown> = {};
    vm.runInNewContext(MATCH_SOURCE, context);

    expect(Object.keys(context)).toEqual(["fuzzyMatch"]);
    expect(Object.keys(context.fuzzyMatch as object).sort()).toEqual(["foldForMatch", "fuzzyMatchRanges", "isFuzzyMatch"]);
  });

  it("matches letters in order, adjacent or not, across words", () => {
    expect(matches("fb", "feature/branch")).toBe(true);
    expect(matches("ftbr", "feature/branch")).toBe(true);
    expect(matches("feature/branch", "feature/branch")).toBe(true);
  });

  it("ignores case on both sides", () => {
    expect(matches("FB", "feature/branch")).toBe(true);
    expect(matches("fb", "Feature/Branch")).toBe(true);
    expect(marked("MAIN", "origin/Main")).toBe("origin/[Main]");
  });

  it("requires the query's order", () => {
    expect(matches("bf", "feature/branch")).toBe(false);
    expect(marked("bf", "feature/branch")).toBeNull();
  });

  it("rejects missing letters and queries longer than the text", () => {
    expect(matches("fz", "feature/branch")).toBe(false);
    expect(matches("mainline", "main")).toBe(false);
    expect(matches("aa", "a")).toBe(false);
  });

  it("matches every text with an empty query and marks nothing", () => {
    expect(matches("", "main")).toBe(true);
    expect(matches("", "")).toBe(true);
    expect(fuzzy.fuzzyMatchRanges("", "main")).toEqual([]);
  });

  it("marks the matched letters as UTF-16 ranges, adjacent ones merged", () => {
    expect(fuzzy.fuzzyMatchRanges(fuzzy.foldForMatch("mn"), "main")).toEqual([{ start: 0, end: 1 }, { start: 3, end: 4 }]);
    expect(fuzzy.fuzzyMatchRanges(fuzzy.foldForMatch("ai"), "main")).toEqual([{ start: 1, end: 3 }]);
  });

  it("prefers word starts after separators to earlier letters", () => {
    expect(marked("fix", "prefix/fix")).toBe("prefix/[fix]");
    expect(marked("lb", "release/build")).toBe("re[l]ease/[b]uild");
    expect(marked("cm", "Checked out branch (main)")).toBe("[C]hecked out branch ([m]ain)");
    expect(marked("ab", "x_ab_a-b")).toBe("x_[ab]_a-b");
  });

  it("prefers camelCase humps", () => {
    expect(marked("fb", "xfooBar")).toBe("x[f]oo[B]ar");
    expect(marked("ib", "fixbugIssueBuild")).toBe("fixbug[I]ssue[B]uild");
  });

  it("prefers runs of adjacent letters", () => {
    expect(marked("main", "remotes/origin/main")).toBe("remotes/origin/[main]");
    expect(marked("main", "my-admin-main")).toBe("my-admin-[main]");
  });

  it("matches and marks characters outside the BMP by code point", () => {
    expect(matches("🚀x", "a🚀bx")).toBe(true);
    expect(fuzzy.fuzzyMatchRanges(fuzzy.foldForMatch("🚀x"), "a🚀bx")).toEqual([{ start: 1, end: 3 }, { start: 4, end: 5 }]);
  });

  it("folds non-ASCII letters", () => {
    expect(marked("ÅÄÖ", "fix/åäö")).toBe("fix/[åäö]");
    expect(marked("σ", "ΣΙΓΜΑ")).toBe("[Σ]ΙΓΜΑ");
    expect(matches("é", "e")).toBe(false);
  });

  it("keeps marks aligned when lower-casing lengthens a letter", () => {
    expect(marked("x", "İx")).toBe("İ[x]");
  });

  it("marks a lengthened letter matched by part or all of its folding", () => {
    expect(matches("i", "İx")).toBe(true);
    expect(marked("i", "İx")).toBe("[İ]x");
    expect(marked("ix", "İx")).toBe("[İx]");
    expect(marked("İx", "İx")).toBe("[İx]");
    expect(marked("x", "aİx")).toBe("aİ[x]");
  });

  it("marks every text it matches, and none it does not", () => {
    const texts = ["İx", "aİb", "ΑΣ", "ας", "Straße", "STRASSE", "ﬁx", "🚀x", "a🚀bx", "fix/İstanbul-Σ", "Ǆemal", ""];
    const queries = ["i", "i̇", "İ", "x", "ix", "σ", "ς", "ß", "ss", "ﬁ", "fi", "🚀", "ǆ", "Ǆ", "is", "ab", "a"];
    for (const text of texts) {
      for (const query of queries) {
        const isMarked = fuzzy.fuzzyMatchRanges(fuzzy.foldForMatch(query), text) !== null;
        expect(isMarked, `${query} in ${text}`).toBe(matches(query, text));
      }
    }
  });

  it("does not take half of a surrogate pair for a match", () => {
    expect(matches("😀", "🚀")).toBe(false);
    expect(marked("😀", "🚀")).toBeNull();
  });
});
