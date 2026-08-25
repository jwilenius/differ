# Differ

IntelliJ-style three-way merge conflict viewer for VS Code.

Renders a conflicted file as one aligned tri-pane grid — local, base, remote — with per-side change bars, word-level
highlighting inside modified lines, and per-conflict resolution buttons.

## Why

VS Code ships a built-in 3-way merge editor. Differ's value is the presentation: rows are aligned across all three panes
(shorter panes get hatched filler), every changed block is classified and colour-coded, and only the words that actually
changed are highlighted.

## Change indication

| Block kind     | Meaning                                  | Shown as                     |
| -------------- | ---------------------------------------- | ---------------------------- |
| `unchanged`    | All three sides agree                    | No tint                      |
| `localChange`  | Only local changed the base              | Green tint + bar, local pane |
| `remoteChange` | Only remote changed the base             | Blue tint + bar, remote pane |
| `bothSame`     | Both sides made the identical change     | Tint on both sides           |
| `conflict`     | Both sides changed the same lines, apart | Orange tint + bar on base    |
| filler         | A pane has no line at this row           | Hatched cell                 |

Word-level spans compare each side against base; with 2-way markers (no `|||||||` block) they compare the two sides
against each other.

## Resolving

Each conflict gets an action bar: **Accept Left**, **Accept Base**, **Accept Right**, **Both: L, R**, **Both: R, L**.
Resolving replaces the conflict and its markers in the underlying document via a `WorkspaceEdit`, so undo works and the
file is not saved for you.

`F7` / `Alt+↓` jumps to the next conflict, `Shift+F7` / `Alt+↑` to the previous.

## Commands & settings

| Id                             | Description                                                       |
| ------------------------------ | ----------------------------------------------------------------- |
| `differ.openMergeView`         | Open the merge view for the active file (title bar button appears |
|                                | when conflict markers are detected)                               |
| `differ.showBasePane`          | Show the base pane between local and remote (default `true`)      |
| `differ.wordLevelHighlighting` | Highlight changed words inside modified lines (default `true`)    |

## Development

```sh
npm install         # deps
npm run build       # bundle to dist/extension.js
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
npm test            # vitest, core + view model
```

Press `F5` in VS Code to launch an Extension Development Host, then open `samples/conflicted.ts` and run
**Differ: Open Three-Way Merge View**.

> The `.vscode/` path in this checkout is a device node, not a directory, so no `launch.json` could be written. If `F5`
> offers no "Run Extension" configuration, add one with `type: extensionHost` and
> `args: ["--extensionDevelopmentPath=${workspaceFolder}"]`.

## Layout

| Path                          | Role                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `src/core/conflictParser.ts`  | Splits a document into stable and conflict sections         |
| `src/core/lineDiff.ts`        | Line diff → hunks + base↔side position maps                 |
| `src/core/wordDiff.ts`        | Intra-line changed character ranges                         |
| `src/core/threeWayAligner.ts` | Aligns the three sides into one row grid, classifies blocks |
| `src/core/mergeResolver.ts`   | Collapses a conflict under a chosen resolution              |
| `src/view/viewModel.ts`       | Whole-file row model with document-wide line numbers        |
| `src/view/rowRenderer.ts`     | Rows, word spans, and action bars → HTML                    |
| `src/view/webviewHtml.ts`     | Page shell, CSP, toolbar                                    |
| `src/view/mergeViewPanel.ts`  | Webview lifecycle, messages, document edits                 |
| `media/`                      | Webview stylesheet and client script                        |

The `core/` layer has no `vscode` import and is unit-tested on its own.
