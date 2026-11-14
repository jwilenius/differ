const LOCAL_MARKER_PATTERN = /^<<<<<<<( |$)/m;

/** Cheap check used to drive the editor title button; scans without splitting. */
export function hasConflictMarkers(text: string): boolean {
  return LOCAL_MARKER_PATTERN.test(text);
}
