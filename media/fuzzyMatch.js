// Fuzzy matching for jw-differ's history client: a query matches a text when the text contains every character of the
// query, in order, ignoring case; the characters need not be adjacent. One global, `fuzzyMatch`, so tests can load this
// file in a bare VM context and call it.
//
// Deciding a match is one greedy pass over the text. Which of the text's characters to mark is chosen only for the
// texts shown: a dynamic program over query × text prefers matches that start words and runs of adjacent matches. The
// bonuses follow the ideas of fzy (MIT licence, John Hawthorn, https://github.com/jhawthorn/fzy/blob/master/ALGORITHM.md);
// this is a smaller, independent implementation without its gap penalties.
//
// Both passes compare the same folded code points, each character lower-cased on its own, so a text is marked exactly
// when it matches, even where lower-casing lengthens a letter (`İ` becomes two code points).
(function () {
  "use strict";

  /** A matched character next to the previous matched one. */
  const RUN_BONUS = 4;
  /** A matched character at the start of the text or after a character that is no letter or digit (`/`, `-`, `_`, `.`, ` `). */
  const WORD_START_BONUS = 3;
  /** A matched upper-case letter after a lower-case one, as in camelCase. */
  const CAMEL_CASE_BONUS = 2;
  const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
  const MAX_BMP_CODE_POINT = 0xffff;

  /** `text` as `isFuzzyMatch` and `fuzzyMatchRanges` compare it: each character lower-cased on its own. */
  function foldForMatch(text) {
    // Lower-casing the whole text gives the same but for `Σ`, the one letter folded by context, and is much faster.
    return text.includes("Σ") ? Array.from(text, foldCharacter).join("") : text.toLowerCase();
  }

  /** One character folded; context-free, unlike lower-casing a whole text (a final `Σ` becomes `ς` there). */
  function foldCharacter(character) {
    return character.toLowerCase();
  }

  /** Whether `foldedText` contains every code point of `foldedQuery` in order; both from `foldForMatch`. O(text length). */
  function isFuzzyMatch(foldedQuery, foldedText) {
    let matched = 0;
    for (let index = 0; index < foldedText.length && matched < foldedQuery.length;) {
      const codePoint = foldedText.codePointAt(index);
      const size = codePoint > MAX_BMP_CODE_POINT ? 2 : 1;
      if (codePoint === foldedQuery.codePointAt(matched)) {
        matched += size;
      }
      index += size;
    }
    return matched === foldedQuery.length;
  }

  /**
   * The parts of `text` to mark for `foldedQuery` (from `foldForMatch`), as `{ start, end }` UTF-16 offsets of runs of
   * matched characters in text order; empty for an empty query, null when `text` does not match. Of all the ways to
   * match, it takes one with the most word starts and adjacent matches; on a tie, the one ending first, then the one
   * whose characters are closest together. O(query length × text length).
   */
  function fuzzyMatchRanges(foldedQuery, text) {
    if (foldedQuery === "") {
      return [];
    }
    const characters = Array.from(text);
    const folded = foldedCodePoints(characters, foldForMatch(text));
    const positions = bestMatchPositions(Array.from(foldedQuery), folded.codePoints, folded.bonuses);
    if (positions === null) {
      return null;
    }
    // Two query code points may match within one character, as both of `İ`'s do.
    const matchedCharacters = new Set(positions.map((position) => folded.owners[position]));
    return rangesOf(characters, [...matchedCharacters]);
  }

  /**
   * `foldedText`, the text of `characters` from `foldForMatch`, as parallel arrays with one entry per code point: the
   * code point, the index of the character it came from, and the bonus of a match there. A character's bonus goes to
   * its first code point; the rest of a lengthened letter add none.
   */
  function foldedCodePoints(characters, foldedText) {
    const characterBonus = characterBonuses(characters);
    const wholeCodePoints = Array.from(foldedText);
    // As every character folds to at least one code point, equal counts mean each folded to exactly one.
    if (wholeCodePoints.length === characters.length) {
      return { codePoints: wholeCodePoints, owners: characters.map((_, index) => index), bonuses: characterBonus };
    }
    const codePoints = [];
    const owners = [];
    const bonuses = [];
    characters.forEach((character, index) => {
      Array.from(foldCharacter(character)).forEach((codePoint, offset) => {
        codePoints.push(codePoint);
        owners.push(index);
        bonuses.push(offset === 0 ? characterBonus[index] : 0);
      });
    });
    return { codePoints, owners, bonuses };
  }

  /** The bonus of a match at each character of `characters`. */
  function characterBonuses(characters) {
    return characters.map((character, index) => {
      const previous = characters[index - 1];
      if (previous === undefined || !LETTER_OR_DIGIT.test(previous)) {
        return WORD_START_BONUS;
      }
      const isCamelCase = previous !== previous.toUpperCase() && character !== character.toLowerCase();
      return isCamelCase ? CAMEL_CASE_BONUS : 0;
    });
  }

  /**
   * Text positions of the best scoring match of `query` in `text` (both folded code points), or null when there is none.
   * `scores[j]` is the best score of the query so far ending with a match at `j`; `from[i][j]` is where query character
   * `i - 1` matched before `i` matched at `j`.
   */
  function bestMatchPositions(query, text, bonuses) {
    const from = [];
    let previousScores = null;
    for (let queryIndex = 0; queryIndex < query.length; queryIndex++) {
      const scores = new Float64Array(text.length).fill(-Infinity);
      const sources = new Int32Array(text.length).fill(-1);
      // Best score of the previous character matched two or more characters before `textIndex`, and where.
      let gapScore = -Infinity;
      let gapSource = -1;
      for (let textIndex = 0; textIndex < text.length; textIndex++) {
        if (previousScores !== null && textIndex >= 2 && previousScores[textIndex - 2] >= gapScore) {
          gapScore = previousScores[textIndex - 2];
          gapSource = textIndex - 2;
        }
        if (text[textIndex] !== query[queryIndex]) {
          continue;
        }
        const bonus = bonuses[textIndex];
        if (previousScores === null) {
          scores[textIndex] = bonus;
          continue;
        }
        const runScore = textIndex >= 1 ? previousScores[textIndex - 1] + Math.max(bonus, RUN_BONUS) : -Infinity;
        const isRunBetter = runScore >= gapScore + bonus;
        scores[textIndex] = isRunBetter ? runScore : gapScore + bonus;
        sources[textIndex] = isRunBetter ? textIndex - 1 : gapSource;
      }
      from.push(sources);
      previousScores = scores;
    }
    return tracedPositions(from, previousScores);
  }

  /** Follows `from` back from the best scoring end in `lastScores`, the first of equals; null when nothing matched. */
  function tracedPositions(from, lastScores) {
    let end = 0;
    for (let index = 1; index < lastScores.length; index++) {
      if (lastScores[index] > lastScores[end]) {
        end = index;
      }
    }
    if (!(lastScores[end] > -Infinity)) {
      return null;
    }
    const positions = [];
    for (let queryIndex = from.length - 1, position = end; queryIndex >= 0; queryIndex--) {
      positions.push(position);
      position = from[queryIndex][position];
    }
    return positions.reverse();
  }

  /** UTF-16 ranges of the characters at `positions` (ascending, distinct), adjacent ones merged. */
  function rangesOf(characters, positions) {
    const ranges = [];
    let offset = 0;
    let next = 0;
    for (let index = 0; index < characters.length && next < positions.length; index++) {
      const end = offset + characters[index].length;
      if (index === positions[next]) {
        next++;
        const last = ranges[ranges.length - 1];
        if (last && last.end === offset) {
          last.end = end;
        } else {
          ranges.push({ start: offset, end });
        }
      }
      offset = end;
    }
    return ranges;
  }

  globalThis.fuzzyMatch = Object.freeze({ foldForMatch, isFuzzyMatch, fuzzyMatchRanges });
})();
