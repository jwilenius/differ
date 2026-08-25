import type { ConflictSection, Section } from "./types";

const LOCAL_MARKER = "<<<<<<<";
const BASE_MARKER = "|||||||";
const SEPARATOR_MARKER = "=======";
const REMOTE_MARKER = ">>>>>>>";

/**
 * Splits a document containing git conflict markers into stable and conflicting
 * sections. Handles both `diff3` markers (with a `|||||||` base block) and plain
 * 2-way markers, in which case the base block is empty and `hasBase` is false.
 */
export function parseConflicts(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];

  let stableStart = 0;
  let index = 0;

  while (index < lines.length) {
    if (!startsWith(lines[index], LOCAL_MARKER)) {
      index++;
      continue;
    }

    if (index > stableStart) {
      sections.push({ kind: "stable", lines: lines.slice(stableStart, index), startLine: stableStart });
    }

    const conflict = readConflict(lines, index);
    if (!conflict) {
      index++;
      continue;
    }

    sections.push(conflict);
    index = conflict.markerEndLine + 1;
    stableStart = index;
  }

  if (stableStart < lines.length) {
    sections.push({ kind: "stable", lines: lines.slice(stableStart), startLine: stableStart });
  }

  return sections;
}

const LOCAL_MARKER_PATTERN = /^<<<<<<<( |$)/m;

/** Cheap check used to drive the editor title button; scans without splitting. */
export function hasConflictMarkers(text: string): boolean {
  return LOCAL_MARKER_PATTERN.test(text);
}

/** Reads one conflict starting at the `<<<<<<<` on `startLine`, or `null` if it is unterminated. */
function readConflict(lines: readonly string[], startLine: number): ConflictSection | null {
  const local: string[] = [];
  const base: string[] = [];
  const remote: string[] = [];

  let target = local;
  let hasBase = false;
  let remoteLabel = "";

  for (let index = startLine + 1; index < lines.length; index++) {
    const line = lines[index];

    if (startsWith(line, BASE_MARKER)) {
      hasBase = true;
      target = base;
      continue;
    }
    if (startsWith(line, SEPARATOR_MARKER)) {
      target = remote;
      continue;
    }
    if (startsWith(line, REMOTE_MARKER)) {
      remoteLabel = labelOf(line, REMOTE_MARKER);
      return {
        kind: "conflict",
        local,
        base,
        remote,
        markerStartLine: startLine,
        markerEndLine: index,
        localLabel: labelOf(lines[startLine], LOCAL_MARKER),
        remoteLabel,
        hasBase,
      };
    }
    // A nested `<<<<<<<` means the markers are malformed; give up on this conflict.
    if (startsWith(line, LOCAL_MARKER)) {
      return null;
    }

    target.push(line);
  }

  return null;
}

function startsWith(line: string | undefined, marker: string): boolean {
  if (line === undefined) {
    return false;
  }
  return line.startsWith(marker) && (line.length === marker.length || line[marker.length] === " ");
}

function labelOf(line: string, marker: string): string {
  return line.slice(marker.length).trim();
}
