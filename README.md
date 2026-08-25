# Differ

IntelliJ-style three-way merge conflict viewer for VS Code.

Renders a conflicted file as one aligned tri-pane grid — local, base, remote — with per-side change bars, word-level
highlighting inside modified lines, and per-conflict resolution buttons.

## Panes

| Pane       | Content                                     | Source                    |
| ---------- | ------------------------------------------- | ------------------------- |
| **Left**   | Your branch's version                       | git stage 2 (`:2:<path>`) |
| **Middle** | The working copy — _what will be committed_ | The file on disk          |
| **Right**  | The incoming version conflicting with yours | git stage 3 (`:3:<path>`) |

The middle pane is the pivot: both sides are diffed **against what you are about to commit**, so each side shows only
what it still disagrees with. Base (stage 1) is read too, and backs the "Revert to base" action.

During a **rebase or cherry-pick** git replays commits onto the other branch, reversing the sense of the two sides. The
toolbar says so when that is the case.

## Change indication

| Row kind     | Meaning                                      | Shown as                            |
| ------------ | -------------------------------------------- | ----------------------------------- |
| `settled`    | All three agree                              | No tint                             |
| `tookOurs`   | Working copy matches your branch             | Green on the result; right dimmed   |
| `tookTheirs` | Working copy matches the incoming side       | Blue on the result; left dimmed     |
| `custom`     | Working copy matches neither — you edited it | Purple on the result                |
| `unresolved` | Still inside `<<<<<<<` markers               | Orange across the row; markers bold |
| filler       | A pane has no line at this row               | Hatched cell                        |

Word-level highlighting marks the characters each side differs by from the working copy.

## Resolving

Each unresolved conflict gets an action bar: **Take &lt;your branch&gt;**, **Revert to base**, **Take &lt;incoming&gt;**,
**Keep both**. Resolving rewrites the conflict in the real file through the host's document port, so undo works and
nothing is saved for you. `F7` / `Shift+F7` step through conflicts.

## Architecture

The merge logic knows nothing about VS Code or HTML, so a second front end — a TUI — only has to supply a renderer and a
document port. `src/test/layering.test.ts` asserts these boundaries rather than trusting them.

```
src/core/    diff, alignment, conflict parsing, resolution   (pure, no I/O)
src/git/     reads the three versions from git's index        (pure Node)
src/model/   view model + controller — renderer-agnostic      <-- the seam
src/render/  MergeRenderer<TOutput>; html/ implements it
src/host/    VS Code wiring: webview, WorkspaceEdit adapter
```

To add a terminal UI: implement `MergeRenderer<string[]>` in `src/render/tui/`, implement `MergeDocument` over `fs`, and
reuse `ResolutionController` unchanged.

| Port / seam              | Contract                                       |
| ------------------------ | ---------------------------------------------- |
| `MergeRenderer<TOutput>` | `render(model, context) => TOutput`            |
| `MergeDocument`          | `getText()`, `replaceLines(start, end, lines)` |
| `ResolutionController`   | `load(options)`, `resolve(index, resolution)`  |

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
