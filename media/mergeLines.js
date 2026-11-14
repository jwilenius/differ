// Result-pane line rules for Differ's merge client. Plain top-level
// functions, so tests can load this file in a bare VM context and call them.

/**
 * The class of every result `.line`, as the host renders it: an unresolved
 * chunk tints its lines, and an empty one marks the gap before the line it
 * precedes, or after the last line when it ends the file.
 *
 * `chunks` are the client data chunks: `{ tint, isResolved, result: [start, end) }`.
 */
function resultLineClasses(chunks, lineCount) {
  const tints = new Map();
  const gaps = new Map();
  for (const chunk of chunks) {
    if (chunk.isResolved) {
      continue;
    }
    const [start, end] = chunk.result;
    if (start === end) {
      gaps.set(start, chunk.tint);
    }
    for (let line = start; line < end; line++) {
      tints.set(line, chunk.tint);
    }
  }

  const classes = [];
  for (let line = 0; line < lineCount; line++) {
    const tint = tints.get(line);
    const gapBefore = gaps.get(line);
    const gapAfter = line === lineCount - 1 ? gaps.get(lineCount) : undefined;
    classes.push(
      [
        "line",
        tint ? `chg-${tint}` : "",
        gapBefore ? `gap-before gap-${gapBefore}` : "",
        gapAfter ? `gap-after gap-${gapAfter}` : "",
      ].filter(Boolean).join(" "),
    );
  }
  return classes;
}
