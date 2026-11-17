import { describe, expect, it } from "vitest";
import { HISTORY_PAGE_SIZE, HtmlHistoryRenderer } from "../render/html/historyRenderer";
import type { HistoryPublicState, HistoryRenderContext, HistoryUpdate } from "../render/html/historyRenderer";
import type { ComparisonFile, ComparisonResult, HistoryCommit, HistoryData, HistoryState } from "../model/historyTypes";

const NONCE = "abcdefghijklmnopqrstuvwxyz012345";

function oid(index: number): string {
  return index.toString(16).padStart(40, "0");
}

const ROOT = oid(1);
const MIDDLE = oid(2);
const SIDE = oid(3);
const MERGE = oid(4);
const SNAPSHOT_ID = "6f1c2a7e-1111-4222-8333-944455556666";

function commit(id: string, subject: string, parents: readonly string[]): HistoryCommit {
  return { oid: id, parents, author: "Ada", authoredDate: "2026-03-04T05:06:07+02:00", subject };
}

const history: HistoryData = {
  commits: [
    commit(MERGE, "Merge side", [MIDDLE, SIDE]),
    commit(SIDE, "Side work", [ROOT]),
    commit(MIDDLE, "Middle work", [ROOT]),
    commit(ROOT, "Initial", []),
  ],
  refs: [
    { kind: "localBranch", name: "main", oid: MERGE },
    { kind: "tag", name: "v1", oid: ROOT },
  ],
  head: null,
  isTruncated: false,
};

function makeState(overrides: Partial<HistoryState> = {}): HistoryState {
  return {
    revision: 3,
    history,
    selectedOids: [],
    base: { kind: "automatic" },
    mainlines: [],
    comparison: null,
    operations: { isLoading: false, isResolvingBase: false, isComparing: false },
    error: null,
    ...overrides,
  };
}

function makeContext(overrides: Partial<HistoryRenderContext> = {}): HistoryRenderContext {
  return {
    assets: { styleUri: "res://history.css", scriptUri: "res://history.js", cspSource: "res:" },
    fuzzyMatchScriptUri: "res://fuzzyMatch.js",
    nonce: NONCE,
    repositories: [{ id: "repo-1", name: "differ" }],
    activeRepositoryId: "repo-1",
    presentation: { search: "", branchChoice: null, branch: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE },
    visibleOids: history.commits.map((entry) => entry.oid),
    hiddenSelectedCount: 0,
    wireRevision: 7,
    openedFile: null,
    ...overrides,
  };
}

function ready(files: readonly ComparisonFile[]): ComparisonResult {
  return { kind: "ready", snapshotId: SNAPSHOT_ID, base: { kind: "commit", oid: ROOT, subject: "Initial" }, orderedOids: [MIDDLE], files };
}

function render(state: Partial<HistoryState> = {}, context: Partial<HistoryRenderContext> = {}): string {
  return new HtmlHistoryRenderer().render(makeState(state), makeContext(context)).html;
}

function decodeAttribute(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function publicState(html: string): HistoryPublicState {
  const match = /<body data-history="([^"]*)">/.exec(html);
  if (!match) {
    throw new Error("no data-history attribute");
  }
  return JSON.parse(decodeAttribute(match[1]!)) as HistoryPublicState;
}

/** The whole `<tr>` of a commit row. */
function rowHtml(html: string, id: string): string {
  const start = html.indexOf(rowFor(html, id));
  return html.slice(start, html.indexOf("</tr>", start) + "</tr>".length);
}

/** `count` branch tips side by side, each on its own parent, all joining one root below. */
function wideHistory(count: number): HistoryData {
  const tips = Array.from({ length: count }, (_, index) => commit(oid(1_000 + index), `tip ${index}`, [oid(2_000 + index)]));
  const bases = Array.from({ length: count }, (_, index) => commit(oid(2_000 + index), `base ${index}`, [ROOT]));
  return { commits: [...tips, ...bases, commit(ROOT, "Initial", [])], refs: [], head: null, isTruncated: false };
}

function renderAll(data: HistoryData): string {
  const visibleOids = data.commits.map((entry) => entry.oid);
  return render({ history: data }, {
    visibleOids,
    presentation: { search: "", branchChoice: null, branch: null, focusedOid: null, rowLimit: visibleOids.length },
  });
}

function numbers(html: string, pattern: RegExp): readonly number[] {
  return [...html.matchAll(pattern)].map((match) => Number(match[1]));
}

function rowFor(html: string, id: string): string {
  const match = new RegExp(`<tr [^>]*data-oid="${id}"[^>]*>`).exec(html);
  if (!match) {
    throw new Error(`no row ${id}`);
  }
  return match[0];
}

describe("HtmlHistoryRenderer", () => {
  it("distinguishes selected rows from the focused row", () => {
    const html = render({ selectedOids: [MIDDLE, SIDE] }, {
      presentation: { search: "", branchChoice: null, branch: null, focusedOid: ROOT, rowLimit: HISTORY_PAGE_SIZE },
    });

    expect(rowFor(html, MIDDLE)).toContain('aria-selected="true"');
    expect(rowFor(html, MIDDLE)).toContain("is-selected");
    expect(rowFor(html, MIDDLE)).not.toContain("is-focused");
    expect(rowFor(html, ROOT)).toContain('aria-selected="false"');
    expect(rowFor(html, ROOT)).toContain("is-focused");
    expect(rowFor(html, ROOT)).toContain('tabindex="0"');
    expect(rowFor(html, MIDDLE)).toContain('tabindex="-1"');
    expect(html).toContain("2 selected");
    expect(html).toContain('id="history-details"');
    expect(html).toContain(`<code>${ROOT}</code>`);
  });

  it("publishes the full selection and wire revision", () => {
    const html = render({ selectedOids: [SIDE, ROOT] }, { visibleOids: [MERGE, MIDDLE], hiddenSelectedCount: 2 });

    expect(publicState(html)).toEqual({
      revision: 7,
      repositoryId: "repo-1",
      selectedOids: [SIDE, ROOT],
      focusedOid: null,
      search: "",
      branch: null,
      rowLimit: HISTORY_PAGE_SIZE,
      snapshotId: null,
      openFileId: null,
    });
    expect(html).toContain("2 hidden by filters");
  });

  it("ends lines to unloaded parents in stubs while true roots end at their node", () => {
    const cut: HistoryData = { ...history, commits: history.commits.filter((entry) => entry.oid !== ROOT), isTruncated: true };

    const truncated = render({ history: cut }, { visibleOids: [MERGE, SIDE, MIDDLE] });
    const complete = render();
    const graphOf = (id: string): string => truncated.slice(truncated.indexOf(rowFor(truncated, id))).split("</tr>")[0]!;

    expect(graphOf(SIDE)).toMatch(/<line class="graph-edge lane-\d graph-cut" x1="18" y1="11" x2="18" y2="20"\/>/);
    expect(graphOf(MIDDLE)).toContain("graph-cut");
    expect(graphOf(MERGE)).not.toContain("graph-cut");
    expect(complete).not.toContain("graph-cut");
  });

  it("keeps stubs to unloaded parents within the node's own column", () => {
    const octopus: HistoryData = {
      commits: [commit(MERGE, "Octopus", [MIDDLE, oid(90), oid(91), oid(92)]), commit(MIDDLE, "Middle work", [])],
      refs: [],
      head: null,
      isTruncated: true,
    };

    const html = render({ history: octopus }, { visibleOids: [MERGE, MIDDLE] });
    const stubs = [...rowHtml(html, MERGE).matchAll(/<line class="[^"]*graph-cut" x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)"/g)];

    expect(stubs).toHaveLength(3);
    expect(stubs.every(([, x1, x2]) => Number(x1) === 6 && Number(x2) > 6 && Number(x2) < 12)).toBe(true);
    expect(rowHtml(html, MERGE)).toContain('<svg class="graph" width="12"');
  });

  it("marks hidden rows in the graph instead of joining visible rows", () => {
    const html = render({}, { visibleOids: [MERGE, ROOT] });

    expect(html).toContain("graph-gap");
    expect(html).toMatch(/<circle class="graph-node lane-\d is-merge" cx="\d+" cy="11" r="3.5"\/>/);
  });

  it("shows the Automatic base resolution and merge-parent choices", () => {
    const comparison: ComparisonResult = {
      kind: "ready",
      snapshotId: SNAPSHOT_ID,
      base: { kind: "commit", oid: MIDDLE, subject: "Middle work" },
      orderedOids: [MERGE],
      files: [],
    };
    const html = render({ selectedOids: [MERGE], mainlines: [{ oid: MERGE, parentNumber: 2 }], comparison });

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(`Automatic: <code>${MIDDLE.slice(0, 8)}</code>`);
    expect(html).toContain(`<select class="mainline-select" data-oid="${MERGE}"`);
    expect(html).toContain(`<option value="1">Parent 1: ${MIDDLE.slice(0, 8)} Middle work</option>`);
    expect(html).toContain(`<option value="2" selected>Parent 2: ${SIDE.slice(0, 8)} Side work</option>`);
    expect(html).toContain("Replay order");
  });

  it("shows a pinned base by label and hash", () => {
    const html = render({ base: { kind: "pinned", oid: ROOT, label: "v1" }, selectedOids: [MIDDLE] });

    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(`<span class="base-pinned">v1</span> <code>${ROOT.slice(0, 8)}</code>`);
    expect(html).toContain('id="history-base-input" type="text" placeholder="Commit, branch or tag" aria-label="Pin base to a commit, branch or tag" value="v1"');
  });

  it("announces loading and comparing in a live status", () => {
    const loading = render({ operations: { isLoading: true, isResolvingBase: false, isComparing: false } });
    const comparing = render({ selectedOids: [MIDDLE], operations: { isLoading: false, isResolvingBase: false, isComparing: true } });

    expect(loading).toContain('role="status" aria-live="polite">Loading history…');
    expect(comparing).toContain("Comparing 1 selected commit…");
  });

  it("asks for a base and offers no files when the selection has several minima", () => {
    const html = render({ selectedOids: [MIDDLE, SIDE], comparison: { kind: "needsBase", minimumOids: [MIDDLE, SIDE] } });

    expect(html).toContain("status-warning");
    expect(html).toContain("pin a base to compare");
    expect(html).not.toContain("data-file-id");
    expect(publicState(html).snapshotId).toBeNull();
  });

  it("names the blocking commit and paths without openable files", () => {
    const comparison: ComparisonResult = {
      kind: "blocked",
      base: { kind: "emptyTree" },
      orderedOids: [ROOT, MIDDLE],
      failingOid: MIDDLE,
      paths: ["src/<a>.ts"],
      explanation: "patch does not apply",
    };
    const html = render({ selectedOids: [ROOT, MIDDLE], comparison });

    expect(html).toContain(`Replay stopped at <code>${MIDDLE.slice(0, 8)}</code>`);
    expect(html).toContain("<li>src/&lt;a&gt;.ts</li>");
    expect(html).toContain(`<li data-oid="${MIDDLE}" class="is-failing">`);
    expect(html).toContain("Automatic: empty tree");
    expect(html).not.toContain("data-file-id");
  });

  it("explains a comparison whose changes cancel out", () => {
    const html = render({ selectedOids: [MIDDLE], comparison: ready([]) });

    expect(html).toContain("no net file changes");
    expect(html).not.toContain("data-file-id");
  });

  it("renders file buttons with opaque IDs, rename labels and metadata tooltips", () => {
    const files: ComparisonFile[] = [
      {
        id: "f-rename",
        status: "renamed",
        base: { path: "old.txt", blob: oid(10), mode: "100644" },
        result: { path: "new.txt", blob: oid(11), mode: "100755" },
        contentKind: "text",
      },
      { id: "f-bin", status: "added", base: null, result: { path: "logo.png", blob: oid(12), mode: "100644" }, contentKind: "binary" },
    ];
    const html = render({ selectedOids: [MIDDLE], comparison: ready(files) });

    expect(html).toContain(`data-snapshot-id="${SNAPSHOT_ID}" data-file-id="f-rename" aria-label="Renamed: old.txt → new.txt"`);
    expect(html).toContain("Mode 100644 → 100755");
    expect(html).toContain('title="logo.png\nBinary file"');
    expect(publicState(html).snapshotId).toBe(SNAPSHOT_ID);
  });

  it("publishes the file the diff panel shows only while its snapshot is the one listed", () => {
    const listed: ComparisonFile = { id: "f-open", status: "added", base: null, result: { path: "a.txt", blob: oid(10), mode: "100644" }, contentKind: "text" };
    const state = { selectedOids: [MIDDLE], comparison: ready([listed]) };

    const shown = render(state, { openedFile: { snapshotId: SNAPSHOT_ID, fileId: "f-open" } });
    const otherSnapshot = render(state, { openedFile: { snapshotId: "7f1c2a7e-1111-4222-8333-944455556666", fileId: "f-open" } });
    const comparing = render({ selectedOids: [MIDDLE] }, { openedFile: { snapshotId: SNAPSHOT_ID, fileId: "f-open" } });

    expect(publicState(shown).openFileId).toBe("f-open");
    expect(publicState(otherSnapshot).openFileId).toBeNull();
    expect(publicState(comparing).openFileId).toBeNull();
  });

  it("renders one page of rows and a Load more action", () => {
    const many = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, index) => commit(oid(100 + index), `c${index}`, []));
    const state = makeState({ history: { commits: many, refs: [], head: null, isTruncated: false } });
    const { html } = new HtmlHistoryRenderer().render(state, makeContext({ visibleOids: many.map((entry) => entry.oid) }));

    expect(html.match(/<tr class="commit-row/g)).toHaveLength(HISTORY_PAGE_SIZE);
    expect(html).toContain(`id="history-load-more" class="load-more" data-row-limit="${HISTORY_PAGE_SIZE * 2}">Load more (1 more)`);
  });

  it("lays out the graph only through the last rendered row on render and Load more, and not on selection change", () => {
    const parentReads = new Map<number, number>();
    const chain = Array.from({ length: 1_000 }, (_, index) => {
      const { parents, ...fields } = commit(oid(100 + index), `c${index}`, index === 999 ? [] : [oid(101 + index)]);
      return Object.defineProperty(fields, "parents", {
        enumerable: true,
        get: () => {
          parentReads.set(index, (parentReads.get(index) ?? 0) + 1);
          return parents;
        },
      }) as HistoryCommit;
    });
    const state = makeState({ history: { commits: chain, refs: [], head: null, isTruncated: false } });
    const visibleOids = chain.map((entry) => entry.oid);
    const renderer = new HtmlHistoryRenderer();
    const contextFor = (rowLimit: number): HistoryRenderContext => makeContext({
      visibleOids,
      presentation: { search: "", branchChoice: null, branch: null, focusedOid: null, rowLimit },
    });
    const deepestRead = (): number => Math.max(...parentReads.keys());
    const totalReads = (): number => [...parentReads.values()].reduce((sum, count) => sum + count, 0);

    const firstPage = contextFor(HISTORY_PAGE_SIZE);
    const { page } = renderer.render(state, firstPage);
    expect(deepestRead()).toBe(HISTORY_PAGE_SIZE - 1);

    const readsBefore = totalReads();
    const selected = renderer.update({ ...state, selectedOids: [oid(150)] }, firstPage, page);
    expect(totalReads() - readsBefore).toBeLessThanOrEqual(5);

    renderer.update(state, { ...firstPage, presentation: { ...firstPage.presentation, rowLimit: HISTORY_PAGE_SIZE * 2 } }, selected.page);
    expect(deepestRead()).toBe(HISTORY_PAGE_SIZE * 2 - 1);
  });

  describe("update", () => {
    function chain(count: number): HistoryData {
      const commits = Array.from({ length: count }, (_, index) => commit(oid(100 + index), `c${index}`, index === count - 1 ? [] : [oid(101 + index)]));
      return { commits, refs: [], head: null, isTruncated: false };
    }

    function rowsIn(markup: string): string[] {
      return [...markup.matchAll(/<tr class="commit-row[^"]*" role="row" data-oid="([0-9a-f]+)"/g)].map((match) => match[1]!);
    }

    it("sends only the regions a selection changes, with the new state and no rows", () => {
      const renderer = new HtmlHistoryRenderer();
      const context = makeContext();
      const { page } = renderer.render(makeState(), context);

      const { update } = renderer.update(makeState({ selectedOids: [MIDDLE] }), { ...context, wireRevision: 8 }, page);

      expect(update.type).toBe("update");
      expect(update.state).toMatchObject({ revision: 8, selectedOids: [MIDDLE] });
      expect(update.regions).not.toHaveProperty("history-commits");
      expect(update.regions["history-selection"]).toContain("1 selected");
      expect(update.appendedRows).toBe("");
    });

    it("sends a change of the file the diff panel shows as state alone", () => {
      const renderer = new HtmlHistoryRenderer();
      const listed: ComparisonFile = { id: "f-open", status: "added", base: null, result: { path: "a.txt", blob: oid(10), mode: "100644" }, contentKind: "text" };
      const state = makeState({ selectedOids: [MIDDLE], comparison: ready([listed]) });
      const context = makeContext();
      const { page } = renderer.render(state, context);

      const { update } = renderer.update(state, { ...context, wireRevision: 8, openedFile: { snapshotId: SNAPSHOT_ID, fileId: "f-open" } }, page);

      expect(update.state).toMatchObject({ revision: 8, openFileId: "f-open" });
      expect(update.regions).toEqual({});
      expect(update.appendedRows).toBe("");
    });

    it("renders the branch filter again only when the history or branch changes", () => {
      const renderer = new HtmlHistoryRenderer();
      let refReads = 0;
      const data = Object.defineProperty({ ...history }, "refs", {
        get: () => {
          refReads += 1;
          return history.refs;
        },
      });
      const context = makeContext();
      const { page } = renderer.render(makeState({ history: data }), context);
      const readsAfterRender = refReads;

      const selected = renderer.update(makeState({ history: data, selectedOids: [MIDDLE] }), context, page);
      expect(refReads).toBe(readsAfterRender);

      const branch = { ref: "refs/heads/main", tipOid: MERGE };
      const filtered = renderer.update(makeState({ history: data }), { ...context, presentation: { ...context.presentation, branchChoice: branch.ref, branch } }, selected.page);
      expect(refReads).toBeGreaterThan(readsAfterRender);
      expect(filtered.update.regions["history-branch"]).toContain(`<option value="refs/heads/main" data-kind="localBranch" selected>main</option>`);
      const readsAfterFilter = refReads;

      renderer.update(makeState({ history: data }), { ...context, presentation: { ...context.presentation, branchChoice: branch.ref, branch: { ...branch } } }, filtered.page);
      expect(refReads).toBe(readsAfterFilter);
    });

    it("sends no regions when only the focus moves without changing the details", () => {
      const renderer = new HtmlHistoryRenderer();
      const context = makeContext();
      const { page } = renderer.render(makeState(), context);

      const { update } = renderer.update(makeState(), { ...context, presentation: { ...context.presentation, focusedOid: null } }, page);

      expect(update.regions).toEqual({});
    });

    it("appends only the rows a larger limit adds, without moving the tab stop", () => {
      const renderer = new HtmlHistoryRenderer();
      const data = chain(HISTORY_PAGE_SIZE * 2 + 50);
      const context = makeContext({ visibleOids: data.commits.map((entry) => entry.oid) });
      const { page } = renderer.render(makeState({ history: data }), context);

      const { update, page: next } = renderer.update(
        makeState({ history: data }),
        { ...context, presentation: { ...context.presentation, rowLimit: HISTORY_PAGE_SIZE * 2 } },
        page,
      );

      expect(update.regions).not.toHaveProperty("history-commits");
      expect(rowsIn(update.appendedRows)).toEqual(data.commits.slice(HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZE * 2).map((entry) => entry.oid));
      expect(update.appendedRows).not.toContain('tabindex="0"');
      expect(update.regions["history-commit-footer"]).toContain("Load more (50 more)");
      expect(next.rows.count).toBe(HISTORY_PAGE_SIZE * 2);
    });

    it("replaces the table when the added rows widen the graph", () => {
      const renderer = new HtmlHistoryRenderer();
      const data = wideHistory(3);
      const context = makeContext({ visibleOids: data.commits.map((entry) => entry.oid), presentation: { search: "", branchChoice: null, branch: null, focusedOid: null, rowLimit: 1 } });
      const { page } = renderer.render(makeState({ history: data }), context);

      const { update } = renderer.update(makeState({ history: data }), { ...context, presentation: { ...context.presentation, rowLimit: 3 } }, page);

      expect(rowsIn(update.regions["history-commits"] ?? "")).toEqual(data.commits.slice(0, 3).map((entry) => entry.oid));
      expect(update.appendedRows).toBe("");
    });

    it("replaces the table, escaped, when the filters change", () => {
      const renderer = new HtmlHistoryRenderer();
      const data: HistoryData = { ...history, commits: history.commits.map((entry) => entry.oid === SIDE ? { ...entry, subject: "<b>side</b>" } : entry) };
      const context = makeContext();
      const { page } = renderer.render(makeState({ history: data }), context);

      const { update } = renderer.update(makeState({ history: data }), { ...context, visibleOids: [SIDE, ROOT] }, page);
      const table = update.regions["history-commits"] ?? "";

      expect(table.startsWith('<table id="history-commits"')).toBe(true);
      expect(rowsIn(table)).toEqual([SIDE, ROOT]);
      expect(table).toContain("&lt;b&gt;side&lt;/b&gt;");
      expect(table).not.toContain("<b>");
    });

    it("sends every region whose markup changed when the history is reloaded", () => {
      const renderer = new HtmlHistoryRenderer();
      const context = makeContext();
      const { page } = renderer.render(makeState({ history: null, operations: { isLoading: true, isResolvingBase: false, isComparing: false } }), { ...context, visibleOids: [] });

      const { update }: { update: HistoryUpdate } = renderer.update(makeState(), context, page);

      expect(rowsIn(update.regions["history-commits"] ?? "")).toEqual(history.commits.map((entry) => entry.oid));
      expect(Object.keys(update.regions)).toEqual(expect.arrayContaining(["history-commits", "history-branch", "history-status", "history-commit-footer"]));
    });
  });

  it("says how many of the newest commits a truncated history shows, with thousands separators", () => {
    const many = Array.from({ length: 1_234 }, (_, index) => commit(oid(100 + index), `c${index}`, []));
    const state = makeState({ history: { commits: many, refs: [], head: null, isTruncated: true } });

    const { html } = new HtmlHistoryRenderer().render(state, makeContext({ visibleOids: many.map((entry) => entry.oid) }));

    expect(html).toContain('role="status" aria-live="polite">Showing the newest 1,234 commits; select commits to see their changes');
    expect(html).toContain('<p id="history-truncated" class="truncated-note">Showing the newest 1,234 commits. Older history is not loaded; raise the <code>jwDiffer.historyMaxCommits</code> setting to load more.</p>');
    expect(html).toContain("Load more (1,034 more)");
  });

  it("keeps the truncation note when filters hide every commit, and other statuses take precedence", () => {
    const truncated: HistoryData = { ...history, isTruncated: true };

    const filtered = render({ history: truncated }, { visibleOids: [] });
    const comparing = render({ history: truncated, selectedOids: [MIDDLE], operations: { isLoading: false, isResolvingBase: false, isComparing: true } });

    expect(filtered).toContain("No commits match the filters");
    expect(filtered).toContain('id="history-truncated"');
    expect(comparing).toContain("Comparing 1 selected commit…");
    expect(comparing).toContain('id="history-truncated"');
  });

  it("offers only branches whose tip is loaded and keeps a selected loaded branch", () => {
    const unloadedTip = oid(99);
    const refs: HistoryData["refs"] = [
      { kind: "localBranch", name: "main", oid: MERGE },
      { kind: "remoteBranch", name: "origin/old", oid: unloadedTip },
      { kind: "localBranch", name: "side", oid: SIDE },
    ];
    const presentation = { search: "", branchChoice: "refs/heads/side", branch: { ref: "refs/heads/side", tipOid: SIDE }, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE };

    const html = render({ history: { ...history, refs, isTruncated: true } }, { presentation });

    expect(html).not.toContain("origin/old");
    expect(html).toContain(`<option value="">All branches</option>`);
    expect(html).toContain(`<option value="refs/heads/main" data-kind="localBranch">main</option>`);
    expect(html).toContain(`<option value="refs/heads/side" data-kind="localBranch" selected>side</option>`);
  });

  it("names each branch option by its ref, gives its kind and selects the chosen one among refs sharing its tip", () => {
    const refs: HistoryData["refs"] = [
      { kind: "localBranch", name: "main", oid: MERGE },
      { kind: "remoteBranch", name: "origin/main", oid: MERGE },
      { kind: "localBranch", name: "origin/main", oid: MERGE },
      { kind: "head", name: "HEAD", oid: SIDE },
      { kind: "tag", name: "v2", oid: MERGE },
    ];
    const presentation = { search: "", branchChoice: "refs/heads/origin/main", branch: { ref: "refs/heads/origin/main", tipOid: MERGE }, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE };

    const html = render({ history: { ...history, refs } }, { presentation });

    const options = [...html.matchAll(/<option value="([^"]*)"(?: data-kind="([^"]+)")?( selected)?>([^<]*)<\/option>/g)]
      .filter((match) => ["", "checked-out", "HEAD"].includes(match[1]!) || match[1]!.startsWith("refs/"))
      .map(([, value, kind, selected, label]) => `${value} ${kind ?? "-"}${selected ?? ""} ${label}`);
    expect(options).toEqual([
      " - All branches",
      "checked-out - Checked out branch",
      "refs/heads/main localBranch main",
      "refs/remotes/origin/main remoteBranch origin/main",
      "refs/heads/origin/main localBranch selected origin/main",
      "HEAD head HEAD",
    ]);
    expect(publicState(html).branch).toBe("refs/heads/origin/main");
  });

  it("selects the checked-out branch option, named after HEAD's branch", () => {
    const presentation = { search: "", branchChoice: "checked-out", branch: { ref: "refs/heads/main", tipOid: MERGE }, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE };

    const html = render({ history: { ...history, head: { branch: "main", oid: MERGE } } }, { presentation });

    expect(html).toContain(`<option value="">All branches</option><option value="checked-out" selected>Checked out branch (main)</option>`);
    expect(html).toContain(`<option value="refs/heads/main" data-kind="localBranch">main</option>`);
    expect(publicState(html).branch).toBe("checked-out");
  });

  it("says the checked-out option shows a detached HEAD's commit", () => {
    const presentation = { search: "", branchChoice: "checked-out", branch: { ref: "HEAD", tipOid: SIDE }, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE };

    const html = render({ history: { ...history, head: { branch: null, oid: SIDE } } }, { presentation });

    expect(html).toContain(`<option value="checked-out" selected>Checked out (detached HEAD)</option>`);
  });

  it("selects All branches without a branch filter", () => {
    const html = render();

    expect(html).toContain(`<option value="" selected>All branches</option>`);
    expect(html).toContain(`<option value="refs/heads/main" data-kind="localBranch">main</option>`);
  });

  it("shows no truncation note for a complete history", () => {
    const html = render();

    expect(html).toContain("Select commits to see their changes");
    expect(html).not.toContain("Showing the newest");
    expect(html).not.toContain("history-truncated");
  });

  it("escapes hostile metadata everywhere", () => {
    const hostile = "<img src=x onerror=alert(1)> \"quoted\"";
    const hostileHistory: HistoryData = {
      commits: [{ ...commit(ROOT, hostile, []), author: hostile }],
      refs: [{ kind: "localBranch", name: hostile, oid: ROOT }],
      head: null,
      isTruncated: false,
    };
    const html = render(
      { history: hostileHistory, selectedOids: [ROOT], error: { operation: "compare", message: hostile } },
      {
        repositories: [{ id: "repo-1", name: hostile }],
        presentation: { search: hostile, branchChoice: null, branch: null, focusedOid: ROOT, rowLimit: HISTORY_PAGE_SIZE },
        visibleOids: [ROOT],
      },
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("\"quoted\"");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;");
    expect(publicState(html).search).toBe(hostile);
  });

  it("allows only the nonce script and local styles", () => {
    const html = render();

    expect(html).toContain(`content="default-src 'none'; style-src res:; script-src 'nonce-${NONCE}'"`);
    expect(html).toContain(`<script nonce="${NONCE}" src="res://fuzzyMatch.js"></script>
<script nonce="${NONCE}" src="res://history.js"></script>`);
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(() => new HtmlHistoryRenderer().render(makeState(), makeContext({ nonce: "x'; script-src *" }))).toThrow();
  });

  it("labels the grid and every control", () => {
    const html = render({ selectedOids: [MERGE] });

    expect(html).toContain('role="grid" aria-label="Commits" aria-multiselectable="true"');
    for (const id of ["history-repository", "history-search", "history-branch-input", "history-branch-list", "history-branch-local-only", "history-base-input"]) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`));
    }
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="history-branch-list"');
    expect(html).toContain('<select id="history-branch" hidden>');
    expect(html).toContain('<button id="history-clear-selection" class="tool">Clear</button>');
    expect(html).toContain('<button id="history-branch-local-only" class="option-toggle" title="Show local branches only" aria-label="Show local branches only" aria-pressed="false"><svg ');
    expect(html).toContain('<option value="" selected>All branches</option>');
  });

  it("reports an empty repository and a load error", () => {
    expect(render({ history: { commits: [], refs: [], head: null, isTruncated: false } }, { visibleOids: [] })).toContain("This repository has no commits");
    expect(render({ error: { operation: "load", message: "git missing" } })).toContain("Could not load history: git missing");
  });
});

describe("HtmlHistoryRenderer graph width", () => {
  const LANE_WIDTH = 12;
  const DRAWN_LANES = 16;
  const OVERFLOW_X = DRAWN_LANES * LANE_WIDTH + LANE_WIDTH / 2;
  const OVERFLOW_EDGE = DRAWN_LANES * LANE_WIDTH;

  it("draws at most 16 lanes plus one overflow column, however wide the history", () => {
    for (const count of [17, 40]) {
      const html = renderAll(wideHistory(count));

      expect(new Set(numbers(html, /<svg class="graph" width="(\d+)"/g))).toEqual(new Set([(DRAWN_LANES + 1) * LANE_WIDTH]));
      expect(Math.max(...numbers(html, / cx="([\d.]+)"/g))).toBe(OVERFLOW_X);
    }
  });

  it("marks commits in the overflow column with a distinct node", () => {
    const html = renderAll(wideHistory(24));

    expect(rowHtml(html, oid(1_000 + 15))).not.toContain("is-overflow");
    for (const index of [16, 20, 23]) {
      expect(rowHtml(html, oid(1_000 + index))).toMatch(new RegExp(`<circle class="graph-node lane-\\d is-overflow" cx="${OVERFLOW_X}" cy="11"`));
    }
  });

  it("draws no line between lanes it does not draw, and clips lines into the overflow at its edge", () => {
    const html = renderAll(wideHistory(24));
    const lines = [...html.matchAll(/<line class="([^"]*)" x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)"/g)]
      .map(([, classes, x1, x2]) => ({ classes: classes!, x1: Number(x1), x2: Number(x2) }));
    const clipped = lines.filter((line) => line.classes.includes("graph-clipped"));

    expect(lines.every((line) => Math.min(line.x1, line.x2) < OVERFLOW_EDGE)).toBe(true);
    expect(lines.every((line) => Math.max(line.x1, line.x2) <= OVERFLOW_X)).toBe(true);
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.every((line) => Math.max(line.x1, line.x2) === OVERFLOW_EDGE)).toBe(true);
  });

  it("explains the collapsed lanes on rows that reach the overflow column", () => {
    const html = renderAll(wideHistory(24));

    expect(rowHtml(html, oid(1_000))).not.toMatch(/<td class="graph-cell"[^>]* title=/);
    expect(rowHtml(html, oid(1_000 + 20))).toMatch(/<td class="graph-cell" role="gridcell" title="[^"]*too wide[^"]*">/);
  });

  it("leaves graphs within 16 lanes unchanged", () => {
    const html = renderAll(wideHistory(DRAWN_LANES));

    expect(new Set(numbers(html, /<svg class="graph" width="(\d+)"/g))).toEqual(new Set([DRAWN_LANES * LANE_WIDTH]));
    expect(html).not.toContain("is-overflow");
    expect(html).not.toContain("graph-clipped");
    expect(html).not.toMatch(/<td class="graph-cell"[^>]* title=/);
    expect(rowHtml(html, oid(1_000 + 15))).toContain(`<circle class="graph-node lane-7" cx="${15 * LANE_WIDTH + 6}" cy="11" r="3.5"/>`);
  });
});
