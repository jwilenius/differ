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

/**
 * The lines a paste of `text` leaves where it lands between `before` and
 * `after`, the text around the caret or selection; each line break in `text`
 * starts a line, and an empty `text` leaves the two joined.
 */
function pastedLines(before, text, after) {
  const lines = text.split(/\r\n|\r|\n/);
  lines[0] = before + lines[0];
  lines[lines.length - 1] += after;
  return lines;
}

/**
 * The result lines an edit message replaces: from `line`, `removed` lines
 * gave way to `added`. `editedLines` in `mergeMessages.ts` reckons them alike.
 */
function editedLines(message) {
  switch (message.type) {
    case "splitLine":
      return { line: message.line, removed: 1, added: 2 };
    case "joinWithPrevious":
      return { line: message.line - 1, removed: 2, added: 1 };
    case "replaceLines":
      return { line: message.line, removed: message.count, added: message.lines.length };
    default:
      return { line: message.line, removed: 1, added: 1 };
  }
}

/** Where result line `line` went through `edits`, made in that order; null once an edit replaced it. */
function lineAfterEdits(edits, line) {
  let current = line;
  for (const edit of edits) {
    if (current >= edit.line + edit.removed) {
      current += edit.added - edit.removed;
    } else if (current >= edit.line) {
      return null;
    }
  }
  return current;
}
