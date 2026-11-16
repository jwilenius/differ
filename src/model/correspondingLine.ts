import { diffLines } from "../core/lineDiff";

/**
 * Where line `line` of `fromText` is in `toText`, both counted from 0: past lines added or removed above it. A line
 * `toText` no longer has goes to where it was, the start of whatever replaced it, and a line past either end to the
 * nearest line. Line endings do not count, so a working copy with CRLF endings still matches.
 */
export function correspondingLine(fromText: string, toText: string, line: number): number {
  const from = fromText.split(/\r?\n/);
  const to = toText.split(/\r?\n/);
  const position = diffLines(from, to).endPosition[Math.min(line, from.length)];
  return Math.min(position, to.length - 1);
}
