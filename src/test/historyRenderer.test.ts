import { describe, expect, it } from "vitest";
import { HISTORY_PAGE_SIZE, HtmlHistoryRenderer } from "../render/html/historyRenderer";
import type { HistoryPublicState, HistoryRenderContext } from "../render/html/historyRenderer";
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
    nonce: NONCE,
    repositories: [{ id: "repo-1", name: "differ" }],
    activeRepositoryId: "repo-1",
    presentation: { search: "", branchOid: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE },
    visibleOids: history.commits.map((entry) => entry.oid),
    hiddenSelectedCount: 0,
    wireRevision: 7,
    ...overrides,
  };
}

function ready(files: readonly ComparisonFile[]): ComparisonResult {
  return { kind: "ready", snapshotId: SNAPSHOT_ID, base: { kind: "commit", oid: ROOT, subject: "Initial" }, orderedOids: [MIDDLE], files };
}

function render(state: Partial<HistoryState> = {}, context: Partial<HistoryRenderContext> = {}): string {
  return new HtmlHistoryRenderer().render(makeState(state), makeContext(context));
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
      presentation: { search: "", branchOid: null, focusedOid: ROOT, rowLimit: HISTORY_PAGE_SIZE },
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

  it("publishes the full selection, rendered rows and wire revision", () => {
    const html = render({ selectedOids: [SIDE, ROOT] }, { visibleOids: [MERGE, MIDDLE], hiddenSelectedCount: 2 });

    expect(publicState(html)).toEqual({
      revision: 7,
      repositoryId: "repo-1",
      selectedOids: [SIDE, ROOT],
      renderedOids: [MERGE, MIDDLE],
      focusedOid: null,
      search: "",
      branchOid: null,
      rowLimit: HISTORY_PAGE_SIZE,
      snapshotId: null,
    });
    expect(html).toContain("2 hidden by filters");
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

  it("renders one page of rows and a Load more action", () => {
    const many = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, index) => commit(oid(100 + index), `c${index}`, []));
    const state = makeState({ history: { commits: many, refs: [] } });
    const html = new HtmlHistoryRenderer().render(state, makeContext({ visibleOids: many.map((entry) => entry.oid) }));

    expect(html.match(/<tr class="commit-row/g)).toHaveLength(HISTORY_PAGE_SIZE);
    expect(html).toContain(`id="history-load-more" class="load-more" data-row-limit="${HISTORY_PAGE_SIZE * 2}">Load more (1 more)`);
    expect(publicState(html).renderedOids).toHaveLength(HISTORY_PAGE_SIZE);
  });

  it("escapes hostile metadata everywhere", () => {
    const hostile = "<img src=x onerror=alert(1)> \"quoted\"";
    const hostileHistory: HistoryData = {
      commits: [{ ...commit(ROOT, hostile, []), author: hostile }],
      refs: [{ kind: "localBranch", name: hostile, oid: ROOT }],
    };
    const html = render(
      { history: hostileHistory, selectedOids: [ROOT], error: { operation: "compare", message: hostile } },
      {
        repositories: [{ id: "repo-1", name: hostile }],
        presentation: { search: hostile, branchOid: null, focusedOid: ROOT, rowLimit: HISTORY_PAGE_SIZE },
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
    expect(html).toContain(`<script nonce="${NONCE}" src="res://history.js"></script>`);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(() => new HtmlHistoryRenderer().render(makeState(), makeContext({ nonce: "x'; script-src *" }))).toThrow();
  });

  it("labels the grid and every control", () => {
    const html = render({ selectedOids: [MERGE] });

    expect(html).toContain('role="grid" aria-label="Commits" aria-multiselectable="true"');
    for (const id of ["history-repository", "history-search", "history-branch", "history-base-input"]) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`));
    }
    expect(html).toContain('<button id="history-clear-selection" class="tool">Clear</button>');
    expect(html).toContain('<option value="" selected>All branches</option>');
  });

  it("reports an empty repository and a load error", () => {
    expect(render({ history: { commits: [], refs: [] } }, { visibleOids: [] })).toContain("This repository has no commits");
    expect(render({ error: { operation: "load", message: "git missing" } })).toContain("Could not load history: git missing");
  });
});
