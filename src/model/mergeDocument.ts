/**
 * The editable working copy, as the resolution logic needs to see it. Hosts
 * supply their own implementation — a `TextDocument` plus `WorkspaceEdit` in
 * VS Code, a file on disk in a terminal UI — so no host API leaks into the model.
 */
export interface MergeDocument {
  /** Absolute path of the file, used to locate its git repository. */
  readonly filePath: string;
  getText(): string;
  /** Replaces whole lines `startLine..endLine` inclusive, 0-based. */
  replaceLines(startLine: number, endLine: number, replacement: readonly string[]): Promise<boolean>;
}
