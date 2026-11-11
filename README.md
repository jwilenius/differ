# Differ

IntelliJ-style Git commit diff viewer and three-way merge conflict resolver for VS Code.

Differ's scope covers reviewing committed changes and resolving merge conflicts. The merge workflow below is
implemented; the commit-history workflow described next is planned.

## Git commit history and diff viewing (planned)

Select any subset of commits, review the files included in their changes, and double-click a file to open its diff
for the selected commits and comparison base.

### History interface

- Keep the file diff in the main editor area.
- Place commit selection in a resizable, hideable bottom pane. Hiding and reopening it preserves selections and the
  comparison base.
- Use IntelliJ's Git Log as the design reference: a branch graph alongside a commit table, with changed files and
  commit details beside it. Show commit message, author, date, abbreviated hash, and branch/tag labels.
- Support individual selection, range selection, and arbitrary non-contiguous multi-selection. Clearly distinguish
  selected commits from the focused row; show the selection count.
- Provide branch filtering and search by commit message or hash. Filtering must not silently change the selection.
- Show the selected commits' changed files with paths and change status, including additions, deletions, and renames.
  Double-click or keyboard activation opens the corresponding diff; label its comparison base and selected commits.
- Keep the active comparison and a control to reopen the history pane visible when the bottom pane is hidden.

### Comparison base

- Allow an explicit commit, branch, or tag as the comparison base, plus an **Automatic** option.
- By default, use the first unselected commit before the earliest selected commit in ancestry order, independent of
  table sorting or filtering. For linear history, this is the parent of the oldest selected commit.
- If the selection starts at the repository's root commit, compare against the empty tree.
- Show the resolved base hash and subject. Automatic mode recalculates when selection changes; an explicit base stays
  fixed until changed or reset to Automatic.

### Comparison semantics

- Apply only the selected commits' parent-relative changes to the comparison base, in ancestor-before-descendant
  order. The result is a temporary snapshot; the working tree, index, branches, and commits remain untouched.
- For non-contiguous selections, omit unselected commits' changes. If a selected change depends on omitted changes
  and cannot be applied cleanly, identify the blocking commit and files. Do not display a partial result as a complete
  comparison.
- Automatic base selection requires one earliest selected commit that is an ancestor of every other selected commit.
  Use that commit's parent; use the empty tree for a root commit. When selected commits have incomparable earliest
  ancestors, require an explicit base.
- Compare a merge commit against its first parent by default, with a visible parent selector. Its changes include
  everything introduced relative to that parent. Selecting both a merge and commits it incorporates can overlap;
  report application conflicts instead of silently discarding selected commits.
- Determine application order using Git's reverse topological traversal of the selected commit IDs, supplied in
  lexical order, then retain only selected IDs. Display that order; table sorting and filtering never change it.
- Resolve an explicit branch or tag to a commit ID when chosen and keep it pinned until the user chooses a new base
  or resets to Automatic.
- Derive both the file list and opened diffs from the same base-to-result snapshot. Show net changes, so changes that
  cancel out disappear. Preserve rename paths; show empty content on the missing side of an addition or deletion.
- Use VS Code's native bottom panel for the hideable history view and its read-only diff editor for file comparisons.
  Keep the selection/base summary and reopen action in the status bar when history is hidden.

References: [IntelliJ Git Log layout](https://www.jetbrains.com/help/idea/log-tab.html) and
[reviewing changes and comparing commits](https://www.jetbrains.com/help/idea/investigate-changes.html).

## Merge conflict resolution

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

Colours and layout follow IntelliJ's merge dialog: branch text, its gutter, the working copy's gutter and text, then the
incoming gutter and text. Each block takes one colour describing what applying a side would do to the working copy.

| Colour | Meaning                                                 |
| ------ | ------------------------------------------------------- |
| Red    | Unresolved conflict — still inside `<<<<<<<` markers    |
| Blue   | Modified — the side has different lines from the result |
| Green  | Added — the side has lines the working copy lacks       |
| Grey   | Deleted — the working copy has lines the side lacks     |
| None   | All three agree, or the side matches the working copy   |

Changed words inside a block take a stronger shade of the block's colour. Marker lines are dimmed and italic. Light
themes use IntelliJ Light's equivalents.

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

Each unresolved conflict gets IntelliJ's gutter arrows on its first row: **»** beside your branch accepts it, **«**
beside the incoming side accepts that. Right-click a conflict (outside the editable lines) for the full menu:
**Accept &lt;your branch&gt;**, **Accept &lt;incoming&gt;**, **Keep both**, **Revert to base** and **Apply selection**.

The `<<<<<<<` marker lines themselves are deliberately **not** editable — they are structural, and a half-typed marker
would corrupt the region. Resolve them with the gutter arrows or the conflict menu, which remove them properly.

## Partial resolution (hunk splitting)

Taking a whole side is often too coarse. Each conflict is therefore split into the smallest pieces the two sides
actually disagree about, and every piece can be decided on its own.

- Lines **both sides agree on** are settled: they are always kept and carry no control.
- Every other piece gets a **checkbox in the gutter beside the middle pane** — one for the branch's lines, one for the
  incoming lines, coloured to match their pane.
- Tick any combination, then choose **Apply selection** from the conflict's right-click menu, which reports how many lines it would commit.
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

| Path                                 | Role                                                         |
| ------------------------------------ | ------------------------------------------------------------ |
| `src/core/conflictParser.ts`         | Splits a document into stable and conflict sections          |
| `src/core/lineDiff.ts`               | Line diff → hunks + base↔side position maps                  |
| `src/core/wordDiff.ts`               | Intra-line changed character ranges                          |
| `src/core/threeWayAligner.ts`        | Aligns the three sides into one row grid, classifies blocks  |
| `src/core/mergeResolver.ts`          | Collapses a conflict under a chosen resolution               |
| `src/git/gitMergeSources.ts`         | Reads the three versions from the index and the working copy |
| `src/model/hunkSplitter.ts`          | Divides a conflict into separately decidable pieces          |
| `src/model/hunkSelection.ts`         | Which side of which piece is pending inclusion               |
| `src/model/resolutionView.ts`        | Row model, conflict summaries, gutter controls               |
| `src/model/resolutionController.ts`  | Host-independent load / resolve / edit / apply               |
| `src/model/mergeDocument.ts`         | Port onto the host's editable document                       |
| `src/render/renderer.ts`             | `MergeRenderer` seam a TUI can implement                     |
| `src/render/html/rowMarkup.ts`       | Rows, word spans, gutter arrows/checkboxes, menus → HTML     |
| `src/render/html/changeHighlight.ts` | IntelliJ change colour per block (added/deleted/modified)    |
| `src/render/html/htmlRenderer.ts`    | Page shell, CSP, toolbar                                     |
| `src/host/vscode/mergeViewPanel.ts`  | Webview lifecycle, messages, document edits                  |
| `media/`                             | Webview stylesheet and client script                         |

The `core/`, `model/` and `render/` layers have no `vscode` import and are unit-tested on their own; `src/test/layering.test.ts` enforces it.
