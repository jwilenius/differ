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

## Editing and resolving

The **middle pane is editable** — it is a real text surface, and what you type is what gets committed. The left and
right panes are read-only references.

| Key                  | Effect                                           |
| -------------------- | ------------------------------------------------ |
| Any text             | Edits that line of the working copy              |
| `Enter`              | Splits the line                                  |
| `Backspace` at col 0 | Joins onto the line above                        |
| `↑` / `↓`            | Moves between editable lines, keeping the column |
| `F7` / `Shift+F7`    | Next / previous unresolved conflict              |

Each unresolved conflict also gets an action bar: **Take &lt;your branch&gt;**, **Revert to base**,
**Take &lt;incoming&gt;**, **Keep both**.

The `<<<<<<<` marker lines themselves are deliberately **not** editable — they are structural, and a half-typed marker
would corrupt the region. Resolve them with the action bar, which removes them properly.

## Partial resolution (hunk splitting)

Taking a whole side is often too coarse. Each conflict is therefore split into the smallest pieces the two sides
actually disagree about, and every piece can be decided on its own.

- Lines **both sides agree on** are settled: they are always kept and carry no control.
- Every other piece gets a **checkbox in the gutter beside the middle pane** — one for the branch's lines, one for the
  incoming lines, coloured to match their pane.
- Tick any combination, then press **Apply selection**, which reports how many lines it would commit.
- Ticking both sides of a piece keeps both, branch first. Ticking neither drops that piece.

The two sides are compared **directly against each other** rather than through the merge base: what matters is where
they disagree, and content both sides arrived at independently is already settled. This also works for 2-way markers,
which carry no base at all.

A conflict keeps its markers while you tick — that is what keeps its pieces derivable — and is rewritten once, on
apply. Selections are pending intent held in the model, not file content, so resolving an earlier conflict renumbers
them rather than losing them.

All edits go through the host's document port, so undo works, and the file is never saved for you.

Typing is debounced before it reaches the document, and the view suppresses the rebuild it would otherwise trigger for
its own edits, so the caret survives. Structural edits (split, join) renumber lines and so apply immediately, with the
caret restored at the join or the start of the new line.

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
reuse `ResolutionController` unchanged — including its editing operations, which are host-independent.

| Port / seam              | Contract                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `MergeRenderer<TOutput>` | `render(model, context) => TOutput`                                                       |
| `MergeDocument`          | `getText()`, `replaceLines(start, end, lines)`                                            |
| `ResolutionController`   | `load(options)`, `resolve(index, resolution)`, `toggleHunk(...)`, `applySelection(index)` |

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

| Path                                | Role                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| `src/core/conflictParser.ts`        | Splits a document into stable and conflict sections          |
| `src/core/lineDiff.ts`              | Line diff → hunks + base↔side position maps                  |
| `src/core/wordDiff.ts`              | Intra-line changed character ranges                          |
| `src/core/threeWayAligner.ts`       | Aligns the three sides into one row grid, classifies blocks  |
| `src/core/mergeResolver.ts`         | Collapses a conflict under a chosen resolution               |
| `src/git/gitMergeSources.ts`        | Reads the three versions from the index and the working copy |
| `src/model/hunkSplitter.ts`         | Divides a conflict into separately decidable pieces          |
| `src/model/hunkSelection.ts`        | Which side of which piece is pending inclusion               |
| `src/model/resolutionView.ts`       | Row model, conflict summaries, gutter controls               |
| `src/model/resolutionController.ts` | Host-independent load / resolve / edit / apply               |
| `src/model/mergeDocument.ts`        | Port onto the host's editable document                       |
| `src/render/renderer.ts`            | `MergeRenderer` seam a TUI can implement                     |
| `src/render/html/rowMarkup.ts`      | Rows, word spans, gutter checkboxes, action bars → HTML      |
| `src/render/html/htmlRenderer.ts`   | Page shell, CSP, toolbar                                     |
| `src/host/vscode/mergeViewPanel.ts` | Webview lifecycle, messages, document edits                  |
| `media/`                            | Webview stylesheet and client script                         |

The `core/`, `model/` and `render/` layers have no `vscode` import and are unit-tested on their own; `src/test/layering.test.ts` enforces it.
