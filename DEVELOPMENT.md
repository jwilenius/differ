# jw-differ development

Building, testing, architecture, releases and publishing. User documentation: [README.md](README.md).

## Build and test

Project-local Node.js (version in `.node-version`; npm included), signature- and checksum-verified into `.node/`:
`scripts/install-node.sh`, then `export PATH="$PWD/.node/bin:$PATH"`.

```sh
npm install         # deps
npm run build       # bundle to dist/extension.js
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
npm test            # vitest, core + view model
npm run check:deps  # lockfile: npm audit (high+) and OSV malware advisories
```

Tests run Git with only `src/test/fixtures/gitconfig` and no inherited `GIT_*` variables
(`src/test/gitTestEnvironment.ts`), so machine or user Git configuration cannot change results.

The [Dependency check](https://github.com/jwilenius/differ/actions/workflows/dependency-check.yml) workflow reruns
`check:deps` and the registry signature check every Monday at 06:23 UTC, and on demand, because packages are often
reported malicious only days after release. GitHub sends failure notifications to the user who created the workflow or
last changed its schedule. In a public repository GitHub disables the schedule after 60 days without repository
activity; re-enable it on the workflow's page.

Press `F5` in VS Code to launch an Extension Development Host, then open `samples/conflicted.ts` and run
**jw-differ: Open Three-Way Merge View**.

> The `.vscode/` path in this checkout is a device node, not a directory, so no `launch.json` could be written. If `F5`
> offers no "Run Extension" configuration, add one with `type: extensionHost` and
> `args: ["--extensionDevelopmentPath=${workspaceFolder}"]`.

## Architecture

The merge and history logic know nothing about VS Code or HTML, so a second front end — a TUI — only has to supply a
renderer. `src/test/layering.test.ts` asserts these boundaries rather than trusting them.

```
src/core/    line and word diff, conflict-marker detection     (pure, no I/O)
src/git/     merge sources, conflicted files; history reads, replay, file content (pure Node)
src/model/   merge session + view models, history controller — renderer-agnostic   <-- the seam
src/render/  html/ renderers for the merge, diff and history webviews
src/host/    VS Code wiring: webview panels, commands, message validation
```

| Port / seam         | Contract                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mergeSession`      | Immutable `MergeState`: `startMerge`, `applySide`, `ignoreSide`, `applyNonConflicting`, `acceptSide`, `editLine`, `splitLine`, `joinWithPrevious`, `tallyMerge` |
| `describeMerge`     | `MergeState` → per-block view (`tint`, side ranges, resolutions, changed words)                                                                                 |
| `HistoryRepository` | `loadHistory`, `resolveRef`, `compare`, `readFile`, `releaseSnapshot` (Git adapter port)                                                                        |
| `HistoryController` | `load()`, `setSelection(oids)`, `setBase(ref)`, `setMainline(oid, parent)`, `compare()`                                                                         |

## Layout

| Path                                     | Role                                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| `src/core/conflictParser.ts`             | Detects git conflict markers in a document                     |
| `src/core/lineDiff.ts`                   | Line diff → hunks + base↔side position maps                    |
| `src/core/wordDiff.ts`                   | Intra-line changed character ranges                            |
| `src/core/threeWayAligner.ts`            | Aligns the three sides into one row grid, classifies blocks    |
| `src/core/mergeResolver.ts`              | Collapses a conflict under a chosen resolution                 |
| `src/git/gitMergeSources.ts`             | Reads the three versions from the index                        |
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
| `src/model/historyBranchFilter.ts`       | Branch filter by ref name; the checked-out option follows HEAD |
| `src/model/historyRefNames.ts`           | Ref namespaces (`refs/heads/`, …) and the ref kinds they give  |
| `src/git/historyGitCommand.ts`           | Binary-safe, bounded, cancellable `git` subprocess runner      |
| `src/git/gitHistoryRepository.ts`        | Commits, refs and pinned ref resolution                        |
| `src/git/historyComparisonResolver.ts`   | Replay order, Automatic base, merge parents                    |
| `src/git/gitSelectionReplay.ts`          | Isolated replay of selected commits in a private repository    |
| `src/git/gitComparisonFiles.ts`          | Net changed files and immutable file content                   |
| `src/git/gitComparisonRepository.ts`     | Git adapter implementing `HistoryRepository`, snapshot leases  |
| `src/render/html/historyRenderer.ts`     | History panel HTML: toolbar, graph, table, files, details      |
| `src/host/vscode/historyViewProvider.ts` | Panel lifecycle, repositories, messages, publishing            |
| `src/host/vscode/historyDiffProvider.ts` | Read-only `jw-differ-history:` documents and `vscode.diff`     |
| `src/host/vscode/historyMessages.ts`     | Validation of every message from the history webview           |
| `src/model/twoWayDiff.ts`                | Line blocks and word spans for the two-way diff                |
| `src/render/html/twoWayDiffRenderer.ts`  | IntelliJ-style two-pane diff HTML with token colours           |
| `src/highlight/`                         | TextMate tokenizing and theme resolution (no VS Code import)   |
| `src/host/vscode/syntaxHighlighting.ts`  | Finds grammars and the active theme among installed extensions |
| `src/host/vscode/twoWayDiffPanel.ts`     | The reusable diff tab and its native-diff fallback             |
| `media/`                                 | Webview stylesheet and client script                           |
| `media/fuzzyMatch.js`                    | Branch filter matcher: in-order letters, marks (fzy ideas)     |
| `media/branchFilter.js`                  | Branch filter combobox: `createBranchFilter`, used by history  |
| `media/grammars/`                        | Fallback grammars: VS Code's grammar-only built-ins + manifest |

`media/*.js` is plain browser script, not bundled: each loads by its own `<script nonce>` tag under the webview CSP, and
tests run it in a `vm` context with a fake DOM (`src/test/historyClientFixture.ts`). The history page loads
`fuzzyMatch.js`, `branchFilter.js`, `history.js`, in that order. The history toolbar is static; host
`update` messages replace marked regions by id. The branch filter is a combobox (`#history-branch-input` +
`#history-branch-list`, both static) over the hidden `<select id="history-branch">` region, which carries the options
(value, label, `data-kind` `localBranch`/`remoteBranch`/`head`); a region patch re-parses the options and refilters an
open list, keeping its typed text, active option and focus. Closed, the input's value is the chosen branch's label
(announced like a select's value); opening clears it for the query (placeholder keeps the label), typing into the closed
input starts the query with the inserted text only (`InputEvent.data`; IME text on `compositionend`), and closing
restores the label. Options render 100 at a time as the list scrolls. The
static `#history-branch-local-only` toggle (`aria-pressed`) drops `remoteBranch` options from the list on the client
only, with no host message; its state lives in the webview view state (`setState`), kept across updates, repository
switches and a recreated document. `branchFilter.js` exposes one global, `createBranchFilter({ input, list,
isLocalBranchesOnly, onPick })` → `{ refresh(select) }`; `history.js` owns the toggle, its persistence and the
presentation message, and calls `refresh` at load and after every update. Tests:
`src/test/historyBranchFilterClient.test.ts`.
`fuzzyMatch.js` (after [fzy](https://github.com/jhawthorn/fzy/blob/master/ALGORITHM.md), MIT) decides a match in one greedy pass per branch and
picks the letters to mark (word starts, camelCase, runs) only for rendered options. It exposes one frozen global,
`fuzzyMatch` → `{ foldForMatch, isFuzzyMatch, fuzzyMatchRanges }`, which `branchFilter.js` reads at call time. Both
passes compare the same per-character lower-cased code points (`İ` folds to two, `Σ` always to `σ`), so a branch is
listed exactly when its marks can be found.

The `core/`, `model/` and `render/` layers have no `vscode` import and are unit-tested on their own; `src/test/layering.test.ts` enforces it.

## Release

Releases are automatic. Every push to `main` runs
[Build and release VS Code installer](https://github.com/jwilenius/differ/actions/workflows/build-vsix.yml): lockfile
malware and high-severity advisory checks, locked install without install scripts, registry signatures, install
scripts, typecheck, tests. A missing-key signature error is retried once, with a fresh npm cache, against
`registry.npmjs.com` (`scripts/check-signatures.sh`): registry.npmjs.org CDN edges can serve stale attestation
documents, and the `.com` alias of the same registry is not CDN-cached. A failed signature check also logs registry
keys, the failing package's attestations and npm's cached Sigstore TUF keys, and uploads npm's debug logs as artifact
**npm-signature-check-logs**. When all
pass, `scripts/next-release-version.mjs` reads the
[Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/) messages since the last release and picks the
bump; the highest bump wins:

| Commits since the last release                                                                   | Release                                      |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `<type>!:` or `<type>(scope)!:` on any type, or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer | major (also from 0.x: `0.4.0` → `1.0.0`)     |
| `feat:` / `feat(scope):`                                                                         | minor                                        |
| `fix:` / `fix(scope):`                                                                           | patch                                        |
| only `docs`, `test`, `chore`, `style`, `refactor`, `perf`, `ci`, `build` or non-conforming       | none: the run builds a development installer |

- Types are case-insensitive (`Feat:`); the footer must be upper case at the start of a line after the header. Only
  the header sets the type: a squashed body listing `feat:` lines does not. A non-conforming header (`Add search`,
  `Merge branch 'x'`, `Revert "..."`) never releases, even with a breaking footer. Merged branches' commits count.
- Last release: the highest `vX.Y.Z` tag reachable from the pushed commit. Without one, the `package.json` version
  counts as the last release and the whole history is scanned, so the first release is one bump over that version.
  With a tag, `package.json` must hold its version, or the run fails: never edit the version by hand.
- Dry run: `node scripts/next-release-version.mjs` prints the next version (or nothing) on stdout, the reason on
  stderr.
- A release run sets the version in `package.json` and `package-lock.json`, packages `jw-differ-X.Y.Z.vsix`, commits
  `chore: release vX.Y.Z` as `github-actions[bot]`, creates annotated tag `vX.Y.Z`, pushes both atomically
  (`--atomic`), then publishes a GitHub Release with the installer and generated notes. Only the tag and publish jobs
  can write to the repository; they run no dependency code. The version is decided before any dependency code runs.
- **Pull after a release:** CI commits to `main`, so `git pull` (`--rebase` with local commits) before pushing again.
- The release commit and tag start no run: pushes made with `GITHUB_TOKEN` trigger no workflow, and `chore:` never
  releases.
- Runs on `main` queue and never overlap; a release in progress is never cancelled; a newer push replaces a run still
  waiting. If `main` moves during a run, the atomic push fails without changing either remote ref and the run fails;
  the run for the newer push releases the same commits. If that push skipped CI, no run retries: use **Run workflow**.
- Skip a run: `[skip ci]` in the pushed head commit's message (no checks, no installer); its commits still count toward
  the next release, which waits for the next run. Retry: **Run workflow** on `main` decides again from the current
  `main`; on another branch it only builds a development installer. If only the **publish** job failed, **Re-run
  failed jobs** publishes the existing tag. A release cannot be forced without a `feat`, `fix` or breaking commit.
- Repository settings: `github-actions[bot]` must be able to push to `main` and create `v*` tags. Branch protection or
  rulesets that require pull requests, status checks or signed commits on `main`, or that restrict `v*` tags, reject
  the push unless GitHub Actions may bypass them.

### Marketplace publishing

Manual promotion of an existing GitHub Release; nothing is rebuilt.

- Promote: `scripts/publish-marketplace.sh X.Y.Z` (or `vX.Y.Z`; needs `gh`, authenticated). It fetches tags, then
  checks: release tag `vX.Y.Z` on `origin`; no `vscode-vX.Y.Z` locally or on `origin`; `X.Y.Z` above every
  `vscode-v*` tag on `origin` (the Marketplace accepts only increasing versions); GitHub Release `vX.Y.Z` has
  `jw-differ-X.Y.Z.vsix`. It then creates annotated tag `vscode-vX.Y.Z` on the release commit (not `HEAD`) and pushes
  only that tag. Pushing the tag by hand works too.
- The tag push runs
  [Publish to VS Code Marketplace](https://github.com/jwilenius/differ/actions/workflows/publish-marketplace.yml)
  (`publish-marketplace.yml`), which checks: tag is `vscode-vX.Y.Z` (plain `X.Y.Z`); `vX.Y.Z` exists on the same
  commit; release asset `jw-differ-X.Y.Z.vsix` downloads; its packaged `extension/package.json` is
  `jwilenius.jw-differ` at `X.Y.Z` (releases up to `v0.5.0` carry publisher `local` and are rejected). Then
  the dependency checks of the build (`check:deps`, `npm ci --ignore-scripts`, `check:signatures`) and
  `vsce publish --oidc --packagePath` with the locked `@vscode/vsce`.
- Authentication: Marketplace Trusted Publishing (GitHub OIDC, no PAT). The Marketplace exchanges the job's OIDC token
  for a credential valid 15 minutes. Policy on publisher `jwilenius`: owner `jwilenius`, repository `differ`, workflow
  `publish-marketplace.yml`, environment `marketplace`; renaming any of them breaks publishing until the policy
  matches.
- Repository settings: environment `marketplace` with deployment branches and tags limited to tag pattern
  `vscode-v*`. Optional: a tag ruleset on `vscode-v*` that restricts creation to maintainers, since creating the tag
  publishes.
- Do not promote `v0.5.0` or earlier (publisher `local`). The dependency checks read the release's lockfile at
  promotion time: a newly published high-severity advisory blocks promotion until a newer release.
- A failed run can be re-run; a version already on the Marketplace fails the publish step. To drop a promotion that
  cannot succeed, delete its `vscode-vX.Y.Z` tag locally and on `origin`: it otherwise counts as promoted.

## Install a development build

Every push to `main` that does not release builds a development installer after the checks pass; a release run keeps
its release installer instead. Manual builds are also available.

1. Open [Build and release VS Code installer](https://github.com/jwilenius/differ/actions/workflows/build-vsix.yml).
2. Select a successful run and download the **jw-differ-vsix** artifact (retained for 30 days).
3. Extract the ZIP to get `jw-differ-main-<commit>.vsix`, named by its 7-character commit hash so it never clashes with
   a release installer. Its internal version is still the last release's.
4. In VS Code, run **Extensions: Install from VSIX...** and select that file.

For a local installer, use Node.js 22, run `npm ci`, then `npm run package`.
