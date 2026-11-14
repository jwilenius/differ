# Differ

IntelliJ-style Git commit diff viewer and three-way merge conflict resolver for VS Code.

Two workflows: review the combined changes of any set of commits, and resolve merge conflicts.

## Git commit history and diff viewing

Select any subset of commits — including non-adjacent ones — and see exactly what those commits change, with nothing
from the commits in between. Double-click a file to open its diff in VS Code's native diff editor.

### Opening it

- Run **Differ: Open Git History**, or open the **Differ** tab in the bottom panel. **Differ: Refresh Git History** (also
  the ↻ button in the view title) reloads commits and refs.
- The repository comes from the active editor and the workspace folders; the picker switches between them, and
  **Open…** adds any local repository folder. Each repository keeps its own selection and base for the session.
- The status bar shows `<repository>: N selected · base …` and reopens the panel when it is hidden. Hiding and
  reopening the panel keeps the selection, base and filters.

### Selecting commits

Layout follows IntelliJ's Git Log: branch graph and commit table (subject, branch/tag labels, author, date, hash) on
the left; changed files, replay order and commit details on the right.

| Gesture                         | Effect                                              |
| ------------------------------- | --------------------------------------------------- |
| Click                           | Select only that commit                             |
| Ctrl/Cmd+click                  | Add or remove one commit                            |
| Shift+click                     | Select the shown range from the last clicked commit |
| Ctrl/Cmd+Shift+click            | Add that range to the selection                     |
| `↑` / `↓`                       | Move focus; details update when you pause           |
| Shift+`↑` / Shift+`↓`, Space    | Extend the selection / toggle the focused commit    |
| **Clear**                       | Deselect everything                                 |
| Double-click or `Enter` on file | Open its diff (base ↔ result) in the editor         |

- **Search** filters by subject or hash (literal, case-insensitive); the branch filter shows commits reachable from
  that branch. Filtering never changes the selection — selected commits it hides are counted next to the selection.
- The table shows 200 commits at a time; **Load more** adds 200.

### Comparison base

- **Automatic** (default): the parent of the earliest selected commit, or the empty tree when that is the root commit.
  The ancestry decides "earliest", not table order or dates. The toolbar shows the resolved hash and subject.
- When the selection has several earliest commits that are not ancestors of each other (for example commits on two
  branches), Differ asks for a base: type a commit, branch or tag and press **Pin**. A pinned ref is resolved once and
  stays on that commit even if the branch later moves; **Automatic** unpins it.
- A selected merge commit gets a parent selector in the replay list (default: first parent). Its changes are taken
  relative to that parent, and the choice also moves the Automatic base when the merge is the earliest commit.

### What is compared

- Differ replays only the selected commits' own changes (each against its parent) onto the base, oldest first, in Git's
  topological order. The replay order is listed in the panel.
- The file list shows the net change from base to result: additions, deletions, modifications, renames, mode changes,
  binary files and submodules. Changes that cancel out disappear; if everything cancels, the panel says so.
- If a selected commit depends on a commit you left out and cannot be applied, replay stops at that commit and lists
  the conflicting paths. No partial result is shown; change the selection or base and it retries.
- Example: on `A ← B ← C ← D`, where B adds `b.txt`, C adds `c.txt` and D adds `d.txt`, selecting B and D compares
  against A and shows only `b.txt` and `d.txt`.
- Opened diffs are snapshots: changing the selection later does not alter a diff that is already open.

### The diff view

Files open in an IntelliJ-style side-by-side diff rather than VS Code's padded one:

- No filler rows. Each side shows only its own lines; inserted lines are one green block on the new side and a thin
  line between the rows of the old side, joined by a curved band. Deleted lines are grey, modified lines blue with the
  changed words in a darker shade.
- Both panes scroll together, keeping corresponding blocks level; `↑`/`↓` (or F7 / Shift+F7) jump between
  differences.
- Syntax colouring uses the grammars of your installed VS Code extensions and the active colour theme (including
  `editor.tokenColorCustomizations` → `textMateRules`), and follows theme changes. Semantic colouring from language
  servers is not applied, so some identifiers can differ slightly from the editor. Files over 500 000 characters, or
  that take more than about 2 seconds to colour, are shown partly or wholly uncoloured.
- **Open in VS Code diff** shows the same comparison in the built-in diff editor. Set `differ.historyDiffViewer` to
  `native` to always use it. Opening another file reuses the same tab.

### Limits

- Read-only: no checkout, staging, commits, ref changes or hooks; the working tree and index are never touched. Replay
  runs in a private temporary repository that borrows the source's objects and is deleted afterwards.
- Local repositories only; no network fetches. Shallow clones load, but a comparison that needs history beyond the
  shallow boundary fails until you deepen the clone with Git.
- Files that are binary, not valid UTF-8, or over 16 MiB open as an explanation (type, size, mode) rather than a text
  diff. Very large histories fail to load rather than showing a truncated graph (64 MiB of Git output per command).

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

The merge and history logic know nothing about VS Code or HTML, so a second front end — a TUI — only has to supply a renderer and a
document port. `src/test/layering.test.ts` asserts these boundaries rather than trusting them.

```
src/core/    diff, alignment, conflict parsing, resolution   (pure, no I/O)
src/git/     merge sources; history reads, replay, file content (pure Node)
src/model/   view models + controllers — renderer-agnostic    <-- the seam
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
| `HistoryRepository`      | `loadHistory`, `resolveRef`, `compare`, `readFile`, `releaseSnapshot` (Git adapter port)  |
| `HistoryController`      | `load()`, `setSelection(oids)`, `setBase(ref)`, `setMainline(oid, parent)`, `compare()`   |

## Install from GitHub Releases

1. Open [Releases](https://github.com/jwilenius/differ/releases/latest).
2. Download the `differ-<version>.vsix` file under **Assets**.
3. In VS Code, run **Extensions: Install from VSIX...** and select that file.

To publish a release, start with a clean `main` matching `origin/main`, with Node.js 22, npm, Bash, and Git available:

```sh
bash scripts/release.sh 0.2.1   # same as: npm run release -- 0.2.1
```

Choose an unused version greater than the current version, as plain `X.Y.Z` without the `v`. The script refuses to
run unless you are on `main` with a clean tree matching `origin/main` and tag `vX.Y.Z` does not exist. It puts
`/tmp/node-v22.23.4-linux-x64/bin` on `PATH` when present; set `NODE_BIN` to use another Node.js 22. The script installs locked dependencies, runs typecheck
and tests, updates both package files, builds the VSIX, commits, tags, and atomically pushes the commit and tag.
GitHub Actions then attaches the installer to a release with generated notes.

If packaging fails after the version update, the changed package files remain available to inspect or revert.
If pushing fails, the release commit and tag remain local; fix the push error and retry
`git push --atomic origin main refs/tags/v0.1.1` with the version you chose. Do not rerun the release command for that tag.

## Install a development build

Every push to `main` builds a VS Code installer after typecheck and tests pass. Manual builds are also available.

1. Open [Build VS Code installer](https://github.com/jwilenius/differ/actions/workflows/build-vsix.yml).
2. Select a successful run and download the **differ-vsix** artifact (retained for 30 days).
3. Extract the ZIP to get `differ-0.1.0.vsix`.
4. In VS Code, run **Extensions: Install from VSIX...** and select that file.

For a local installer, use Node.js 22, run `npm ci`, then `npm run package`.

## Build and test

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

| Path                                     | Role                                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| `src/core/conflictParser.ts`             | Splits a document into stable and conflict sections            |
| `src/core/lineDiff.ts`                   | Line diff → hunks + base↔side position maps                    |
| `src/core/wordDiff.ts`                   | Intra-line changed character ranges                            |
| `src/core/threeWayAligner.ts`            | Aligns the three sides into one row grid, classifies blocks    |
| `src/core/mergeResolver.ts`              | Collapses a conflict under a chosen resolution                 |
| `src/git/gitMergeSources.ts`             | Reads the three versions from the index and the working copy   |
| `src/model/hunkSplitter.ts`              | Divides a conflict into separately decidable pieces            |
| `src/model/hunkSelection.ts`             | Which side of which piece is pending inclusion                 |
| `src/model/resolutionView.ts`            | Row model, conflict summaries, gutter controls                 |
| `src/model/resolutionController.ts`      | Host-independent load / resolve / edit / apply                 |
| `src/model/mergeDocument.ts`             | Port onto the host's editable document                         |
| `src/render/renderer.ts`                 | `MergeRenderer` seam a TUI can implement                       |
| `src/render/html/rowMarkup.ts`           | Rows, word spans, gutter arrows/checkboxes, menus → HTML       |
| `src/render/html/changeHighlight.ts`     | IntelliJ change colour per block (added/deleted/modified)      |
| `src/render/html/htmlRenderer.ts`        | Page shell, CSP, toolbar                                       |
| `src/host/vscode/mergeViewPanel.ts`      | Webview lifecycle, messages, document edits                    |
| `src/model/historyTypes.ts`              | History domain types and the `HistoryRepository` port          |
| `src/model/historyController.ts`         | Selection, base, merge parents, cancellable comparisons        |
| `src/model/historyGraph.ts`              | Branch graph lanes and edges per commit row                    |
| `src/model/historyVisibility.ts`         | Search and branch filtering of loaded commits                  |
| `src/git/historyGitCommand.ts`           | Binary-safe, bounded, cancellable `git` subprocess runner      |
| `src/git/gitHistoryRepository.ts`        | Commits, refs and pinned ref resolution                        |
| `src/git/historyComparisonResolver.ts`   | Replay order, Automatic base, merge parents                    |
| `src/git/gitSelectionReplay.ts`          | Isolated replay of selected commits in a private repository    |
| `src/git/gitComparisonFiles.ts`          | Net changed files and immutable file content                   |
| `src/git/gitComparisonRepository.ts`     | Git adapter implementing `HistoryRepository`, snapshot leases  |
| `src/render/html/historyRenderer.ts`     | History panel HTML: toolbar, graph, table, files, details      |
| `src/host/vscode/historyViewProvider.ts` | Panel lifecycle, repositories, messages, publishing            |
| `src/host/vscode/historyDiffProvider.ts` | Read-only `differ-history:` documents and `vscode.diff`        |
| `src/host/vscode/historyMessages.ts`     | Validation of every message from the history webview           |
| `src/model/twoWayDiff.ts`                | Line blocks and word spans for the two-way diff                |
| `src/render/html/twoWayDiffRenderer.ts`  | IntelliJ-style two-pane diff HTML with token colours           |
| `src/highlight/`                         | TextMate tokenizing and theme resolution (no VS Code import)   |
| `src/host/vscode/syntaxHighlighting.ts`  | Finds grammars and the active theme among installed extensions |
| `src/host/vscode/twoWayDiffPanel.ts`     | The reusable diff tab and its native-diff fallback             |
| `media/`                                 | Webview stylesheet and client script                           |

The `core/`, `model/` and `render/` layers have no `vscode` import and are unit-tested on their own; `src/test/layering.test.ts` enforces it.
