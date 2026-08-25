import type { ConflictSection } from "./types";

export type Resolution = "local" | "remote" | "base" | "localThenRemote" | "remoteThenLocal";

/** The lines a conflict collapses to under a given resolution. */
export function resolvedLines(conflict: ConflictSection, resolution: Resolution): readonly string[] {
  switch (resolution) {
    case "local":
      return conflict.local;
    case "remote":
      return conflict.remote;
    case "base":
      return conflict.base;
    case "localThenRemote":
      return [...conflict.local, ...conflict.remote];
    case "remoteThenLocal":
      return [...conflict.remote, ...conflict.local];
  }
}

/**
 * Replaces one conflict — markers included — with its resolved lines and returns
 * the rewritten document.
 */
export function applyResolution(text: string, conflict: ConflictSection, resolution: Resolution): string {
  const lines = text.split("\n");
  const replacement = resolvedLines(conflict, resolution);
  const before = lines.slice(0, conflict.markerStartLine);
  const after = lines.slice(conflict.markerEndLine + 1);

  return [...before, ...replacement, ...after].join("\n");
}
