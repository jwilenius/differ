import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_PAGE_SIZE, HtmlHistoryRenderer } from "../render/html/historyRenderer";
import type { HistoryData } from "../model/historyTypes";
import { STAGED_CHANGES_ID, UNSTAGED_CHANGES_ID } from "../model/historyWorkingChanges";
import type { WorkingChangeSummary } from "../model/historyWorkingChanges";
import { A, B, C, D, E, commit, FakeElement, FakeEvent, FakeHost, FakeWebview, FILE_ID, FOCUS_DEBOUNCE_MS, FRAME_MS, history, NONCE, oid, open, OTHER_FILE_ID, OTHER_REPOSITORY_ID, publish, SNAPSHOT_ID } from "./historyClientFixture";

// -------------------------------------------------------------------- tests

describe("history client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces itself with the published revision", () => {
    const webview = open({ revision: 12 });

    expect(webview.posted).toEqual([{ type: "ready", revision: 12 }]);
  });

  it("selects one commit on a plain click and focuses it", () => {
    const webview = open({ selectedOids: [B, C] });

    webview.click(webview.row(D));

    expect(webview.last()).toEqual({ type: "select", revision: 7, oids: [D], focusedOid: D });
  });

  it("toggles commits with Ctrl and Cmd click", () => {
    const webview = open({ selectedOids: [B] });

    webview.click(webview.row(D), { ctrlKey: true });
    webview.click(webview.row(B), { metaKey: true });

    expect(webview.intents()).toEqual([
      { type: "select", revision: 7, oids: [B, D], focusedOid: D },
      { type: "select", revision: 7, oids: [D], focusedOid: B },
    ]);
  });

  it("builds a second toggle on the first before the host publishes it", () => {
    const webview = open();

    webview.click(webview.row(B), { ctrlKey: true });
    webview.click(webview.row(C), { ctrlKey: true });

    expect(webview.intents()).toEqual([
      { type: "select", revision: 7, oids: [B], focusedOid: B },
      { type: "select", revision: 7, oids: [B, C], focusedOid: C },
    ]);
  });

  it("selects the rendered range from the anchor with Shift click", () => {
    const first = open({ selectedOids: [] });
    first.click(first.row(B));
    const second = new FakeWebview();
    second.state = first.state;

    second.load(publish({ selectedOids: [B], focusedOid: B }));
    second.click(second.row(D), { shiftKey: true });

    expect(second.last()).toEqual({ type: "select", revision: 7, oids: [B, C, D], focusedOid: D });
  });

  it("prefers the clicked anchor over a focus moved by arrow keys", () => {
    const first = open();
    first.click(first.row(B));
    const second = new FakeWebview();
    second.state = first.state;

    second.load(publish({ selectedOids: [B], focusedOid: D }));
    second.click(second.row(E), { shiftKey: true });

    expect(second.last()).toEqual({ type: "select", revision: 7, oids: [B, C, D, E], focusedOid: E });
  });

  it("unions the range with the selection on Ctrl+Shift click", () => {
    const webview = open({ selectedOids: [A], focusedOid: C });

    webview.click(webview.row(E), { ctrlKey: true, shiftKey: true });

    expect(webview.last()).toEqual({ type: "select", revision: 7, oids: [A, C, D, E], focusedOid: E });
  });

  it("keeps selections hidden by filters when a Shift range replaces the visible ones", () => {
    const webview = open({ selectedOids: [A, E, B], visibleOids: [B, C, D], focusedOid: B });

    webview.click(webview.row(C), { shiftKey: true });

    expect(webview.last()).toEqual({ type: "select", revision: 7, oids: [A, E, B, C], focusedOid: C });
  });

  it("moves focus with arrow keys at once and tells the host once the user pauses", () => {
    const webview = open({ focusedOid: B });

    const event = webview.key(webview.row(B), "ArrowDown");
    webview.key(webview.row(C), "ArrowDown");

    expect(event.defaultPrevented).toBe(true);
    expect(webview.document.activeElement).toBe(webview.row(D));
    expect(webview.row(D).classList.contains("is-focused")).toBe(true);
    expect(webview.row(D).getAttribute("aria-current")).toBe("true");
    expect(webview.row(D).getAttribute("tabindex")).toBe("0");
    expect(webview.row(B).classList.contains("is-focused")).toBe(false);
    expect(webview.row(B).getAttribute("aria-current")).toBeNull();
    expect(webview.row(B).getAttribute("tabindex")).toBe("-1");
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS - 1);
    expect(webview.intents()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(webview.intents()).toEqual([{
      type: "presentation",
      revision: 7,
      search: "",
      branch: null,
      focusedOid: D,
      rowLimit: HISTORY_PAGE_SIZE,
    }]);
  });

  it("keeps an unsent arrow focus when another publication replaces the document", () => {
    const first = open({ focusedOid: B });
    first.key(first.row(B), "ArrowDown");

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ focusedOid: B, revision: 8 }));

    expect(second.document.activeElement).toBe(second.row(C));
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);
    expect(second.intents()).toEqual([
      { type: "presentation", revision: 8, search: "", branch: null, focusedOid: C, rowLimit: HISTORY_PAGE_SIZE },
    ]);
  });

  it("sends a pending arrow focus with the next selection instead of separately", () => {
    const webview = open({ focusedOid: B });

    webview.key(webview.row(B), "ArrowDown");
    webview.key(webview.row(C), " ");
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);

    expect(webview.intents()).toEqual([{ type: "select", revision: 7, oids: [C], focusedOid: C }]);
  });

  it("stops at the last rendered row", () => {
    const webview = open({ focusedOid: E });

    webview.key(webview.row(E), "ArrowDown");

    expect(webview.intents()).toEqual([]);
  });

  it("extends the selection with Shift+Arrow and toggles with Space", () => {
    const webview = open({ selectedOids: [B], focusedOid: B });

    webview.key(webview.row(B), "ArrowDown", { shiftKey: true });
    webview.key(webview.row(B), " ");

    expect(webview.intents()).toEqual([
      { type: "select", revision: 7, oids: [B, C], focusedOid: C },
      { type: "select", revision: 7, oids: [C], focusedOid: B },
    ]);
  });

  it("only opens a file on double-click or Enter", () => {
    const webview = open({ selectedOids: [B] });
    const file = webview.find("button.file-row", (element) => element.dataset.fileId === FILE_ID);

    webview.click(file);
    expect(webview.intents()).toEqual([]);

    file.dispatch(new FakeEvent("dblclick", file));
    const enter = webview.key(file, "Enter");

    const openIntent = { type: "openFile", revision: 7, snapshotId: SNAPSHOT_ID, fileId: FILE_ID };
    expect(webview.intents()).toEqual([openIntent, openIntent]);
    expect(enter.defaultPrevented).toBe(true);
  });

  it("sends typed intents from the toolbar, base and merge-parent controls", () => {
    const webview = open({ selectedOids: [A] });

    webview.click(webview.element("history-refresh"));
    webview.click(webview.element("history-choose-repository"));
    webview.change(webview.element("history-repository"), OTHER_REPOSITORY_ID);
    webview.click(webview.element("history-base-automatic"));
    webview.type(webview.element("history-base-input"), "  v1.0  ");
    webview.key(webview.element("history-base-input"), "Enter");
    webview.change(webview.find("select.mainline-select", (element) => element.dataset.oid === A), "2");
    webview.click(webview.element("history-clear-selection"));
    webview.click(webview.element("history-select-branch"));

    expect(webview.intents()).toEqual([
      { type: "refresh", revision: 7 },
      { type: "chooseRepository", revision: 7 },
      { type: "repository", revision: 7, repositoryId: OTHER_REPOSITORY_ID },
      { type: "base", revision: 7, ref: null },
      { type: "base", revision: 7, ref: "v1.0" },
      { type: "mainline", revision: 7, oid: A, parentNumber: 2 },
      { type: "select", revision: 7, oids: [], focusedOid: null },
      { type: "selectBranch", revision: 7 },
    ]);
  });

  it("ignores an empty base ref", () => {
    const webview = open();

    webview.click(webview.element("history-base-pin"));

    expect(webview.intents()).toEqual([]);
  });

  it("changes only presentation for branch filters and Load more", () => {
    const many: HistoryData = { commits: Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, index) => commit(oid(100 + index), `c${index}`, [])), refs: history.refs, head: null, isTruncated: false };
    const { html } = new HtmlHistoryRenderer().render(
      { revision: 1, history: many, workingChanges: null, selectedOids: [], base: { kind: "automatic" }, mainlines: [], comparison: null, operations: { isLoading: false, isResolvingBase: false, isComparing: false }, error: null },
      {
        assets: { styleUri: "s", scriptUri: "j", cspSource: "res:" },
        fuzzyMatchScriptUri: "m",
        branchFilterScriptUri: "b",
        nonce: NONCE,
        repositories: [],
        activeRepositoryId: null,
        presentation: { search: "", branchChoice: null, branch: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE },
        visibleOids: many.commits.map((entry) => entry.oid),
        visibleWorkingIds: [],
        hiddenSelectedCount: 0,
        wireRevision: 3,
        openedFile: null,
        selectBranch: { isEnabled: false, title: "No checked-out commit to select a branch from" },
      },
    );
    const webview = new FakeWebview().load(html);

    webview.click(webview.element("history-load-more"));
    webview.pickBranch("checked");

    expect(webview.intents()).toEqual([
      { type: "presentation", revision: 3, search: "", branch: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE * 2 },
      { type: "presentation", revision: 3, search: "", branch: "checked-out", focusedOid: null, rowLimit: HISTORY_PAGE_SIZE },
    ]);
  });

  it("sends the published branch ref with other presentation changes and shows it selected", () => {
    const webview = open({ branch: { ref: "refs/heads/main", tipOid: A }, rowLimit: 1 });

    expect(webview.element("history-branch-input").placeholder).toBe("main");
    webview.click(webview.element("history-load-more"));
    webview.pickBranch("all");

    expect(webview.intents()).toEqual([
      { type: "presentation", revision: 7, search: "", branch: "refs/heads/main", focusedOid: null, rowLimit: 1 + HISTORY_PAGE_SIZE },
      { type: "presentation", revision: 7, search: "", branch: null, focusedOid: null, rowLimit: 1 },
    ]);
  });

  it("sends the checked-out branch choice until a branch is picked, and can pick it again", () => {
    const webview = open({ branchChoice: "checked-out", branch: { ref: "refs/heads/main", tipOid: A }, rowLimit: 1 });

    expect(webview.element("history-branch-input").placeholder).toBe("Checked out branch");
    webview.click(webview.element("history-load-more"));
    webview.pickBranch("main");
    webview.pickBranch("checked");

    expect(webview.intents()).toEqual([
      { type: "presentation", revision: 7, search: "", branch: "checked-out", focusedOid: null, rowLimit: 1 + HISTORY_PAGE_SIZE },
      { type: "presentation", revision: 7, search: "", branch: "refs/heads/main", focusedOid: null, rowLimit: 1 },
      { type: "presentation", revision: 7, search: "", branch: "checked-out", focusedOid: null, rowLimit: 1 },
    ]);
  });

  it("debounces search by 150 ms", () => {
    const webview = open();
    const search = webview.element("history-search");

    webview.type(search, "f");
    vi.advanceTimersByTime(100);
    webview.type(search, "fix");
    vi.advanceTimersByTime(149);
    expect(webview.intents()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(webview.intents()).toEqual([
      { type: "presentation", revision: 7, search: "fix", branch: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE },
    ]);
  });

  it("restores focus, scroll and an unsent search after a stale render is replaced", () => {
    const first = open({ focusedOid: B });
    first.document.querySelector(".commit-pane")!.scrollTop = 80;
    first.document.querySelector(".commit-pane")!.dispatch(new FakeEvent("scroll", first.document.querySelector(".commit-pane")!));
    vi.advanceTimersByTime(FRAME_MS);
    const search = first.element("history-search");
    search.focus();
    first.type(search, "bra");
    first.click(first.row(C));

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ selectedOids: [C], focusedOid: C, revision: 8 }));

    expect(second.document.querySelector(".commit-pane")!.scrollTop).toBe(80);
    expect(second.element("history-search").value).toBe("bra");
    expect(second.document.activeElement).toBe(second.row(C));
    vi.advanceTimersByTime(150);
    expect(second.last()).toEqual({
      type: "presentation",
      revision: 8,
      search: "bra",
      branch: null,
      focusedOid: C,
      rowLimit: HISTORY_PAGE_SIZE,
    });
  });

  it("sends a search edited back to the published text while another search is in flight", () => {
    const webview = open({ search: "a" });
    const search = webview.element("history-search");

    webview.type(search, "ab");
    vi.advanceTimersByTime(150);
    webview.type(search, "a");
    vi.advanceTimersByTime(150);

    expect(webview.intents().map((message) => message.search)).toEqual(["ab", "a"]);
  });

  it("drops the search draft once the host publishes it", () => {
    const first = open();
    first.type(first.element("history-search"), "bra");

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ search: "bra", revision: 8 }));
    vi.advanceTimersByTime(500);

    expect(second.intents()).toEqual([]);
    expect(second.state).toMatchObject({ searchDraft: null });
  });

  it("restores keyboard focus to the same file", () => {
    const first = open({ selectedOids: [B] });
    first.find("button.file-row", (element) => element.dataset.fileId === OTHER_FILE_ID).focus();

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ selectedOids: [B], revision: 8 }));

    expect(second.document.activeElement?.dataset.fileId).toBe(OTHER_FILE_ID);
  });

  it("marks the file the diff panel shows apart from focus", () => {
    const webview = open({ selectedOids: [B], openFileId: FILE_ID });
    const [shown, other] = [FILE_ID, OTHER_FILE_ID].map((id) => webview.find("button.file-row", (element) => element.dataset.fileId === id));

    expect(shown!.classList.contains("is-open")).toBe(true);
    expect(shown!.getAttribute("aria-current")).toBe("true");
    expect(other!.classList.contains("is-open")).toBe(false);
    expect(other!.hasAttribute("aria-current")).toBe(false);
    expect(webview.document.activeElement).toBeNull();
  });

  it("brings a file a step opened while the panel was hidden into view in the recreated document", () => {
    const first = open({ selectedOids: [B], openFileId: FILE_ID });

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ selectedOids: [B], openFileId: OTHER_FILE_ID, revision: 8 }));

    const fileRow = (id: string): FakeElement => second.find("button.file-row", (element) => element.dataset.fileId === id);
    expect(fileRow(OTHER_FILE_ID).classList.contains("is-open")).toBe(true);
    expect(fileRow(OTHER_FILE_ID).scrolledIntoView).toEqual([{ block: "nearest" }]);
  });

  it("leaves the list where it was when the recreated document shows the same open file", () => {
    const first = open({ selectedOids: [B], openFileId: FILE_ID });

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ selectedOids: [B], openFileId: FILE_ID, revision: 8 }));

    expect(second.find("button.file-row", (element) => element.dataset.fileId === FILE_ID).scrolledIntoView).toEqual([]);
  });

  it("deselects a file whose diff tab closed while the panel was hidden", () => {
    const first = open({ selectedOids: [B], openFileId: FILE_ID });
    first.find("button.file-row", (element) => element.dataset.fileId === FILE_ID).focus();

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ selectedOids: [B], openFileId: null, revision: 8 }));

    expect(second.document.activeElement).toBeNull();
    expect(second.state).toMatchObject({ activeKey: null });
  });

  it("restores an unpinned base ref being typed", () => {
    const first = open();
    const input = first.element("history-base-input");
    input.focus();
    first.type(input, "v1");

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ revision: 8 }));

    expect(second.document.activeElement).toBe(second.element("history-base-input"));
    expect(second.element("history-base-input").value).toBe("v1");
  });

  it("keeps a resized detail column only where the wide layout reads it", () => {
    const first = open();
    const pane = first.document.querySelector(".detail-pane")!;
    pane.style.width = "420px";
    first.document.notify(new FakeEvent("mouseup", first.document));

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ revision: 8 }));

    expect(pane.style.width).toBe("");
    expect(pane.style.getPropertyValue("--detail-width")).toBe("420px");
    const restored = second.document.querySelector(".detail-pane")!;
    expect(restored.style.width).toBe("");
    expect(restored.style.getPropertyValue("--detail-width")).toBe("420px");
  });

  it("saves scroll offsets at most once per frame", () => {
    const webview = open();
    const pane = webview.document.querySelector(".commit-pane")!;
    const before = webview.state;

    for (const offset of [10, 20, 30]) {
      pane.scrollTop = offset;
      pane.dispatch(new FakeEvent("scroll", pane));
    }
    expect(webview.state).toBe(before);
    vi.advanceTimersByTime(FRAME_MS);

    expect(webview.state).toMatchObject({ scroll: { "commit-pane": 30 } });
  });

  it("restores the search caret where it was instead of at the end", () => {
    const first = open();
    const search = first.element("history-search");
    search.focus();
    first.type(search, "bravo");
    search.setSelectionRange(1, 3);
    search.dispatch(new FakeEvent("keyup", search));

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ revision: 8 }));

    const restored = second.element("history-search");
    expect(second.document.activeElement).toBe(restored);
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([1, 3]);
  });

  it("does not take focus back after the panel lost it", () => {
    const first = open({ focusedOid: B });
    first.row(B).focus();
    first.window.notify(new FakeEvent("blur", first.row(B)));

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ focusedOid: B, revision: 8 }));

    expect(second.document.activeElement).toBeNull();
  });

  it("forgets anchor, scroll and drafts of another repository", () => {
    const first = open({ focusedOid: B });
    first.row(B).focus();
    first.type(first.element("history-search"), "x");

    const second = new FakeWebview();
    second.state = first.state;
    second.load(publish({ repositoryId: OTHER_REPOSITORY_ID, revision: 8 }));
    vi.advanceTimersByTime(500);

    expect(second.document.activeElement).toBeNull();
    expect(second.intents()).toEqual([]);
  });

  describe("working-change rows", () => {
    const workingChanges: WorkingChangeSummary = { staged: 1, unstaged: 2, untracked: 1, conflicted: 0, isTruncated: false, contentKey: "k1" };

    it("selects a working-change row like a commit", () => {
      const webview = open({ workingChanges });

      webview.click(webview.row(STAGED_CHANGES_ID));
      webview.click(webview.row(B), { ctrlKey: true });

      expect(webview.intents()).toEqual([
        { type: "select", revision: 7, oids: [STAGED_CHANGES_ID], focusedOid: STAGED_CHANGES_ID },
        { type: "select", revision: 7, oids: [STAGED_CHANGES_ID, B], focusedOid: B },
      ]);
    });

    it("selects a Shift range from a working-change row into the commits", () => {
      const webview = open({ workingChanges });

      webview.click(webview.row(UNSTAGED_CHANGES_ID));
      webview.click(webview.row(B), { shiftKey: true });

      expect(webview.last()).toEqual({ type: "select", revision: 7, oids: [UNSTAGED_CHANGES_ID, STAGED_CHANGES_ID, A, B], focusedOid: B });
    });

    it("moves with arrow keys from the working-change rows into the commits", () => {
      const webview = open({ workingChanges, focusedOid: UNSTAGED_CHANGES_ID });
      webview.row(UNSTAGED_CHANGES_ID).focus();

      webview.key(webview.row(UNSTAGED_CHANGES_ID), "ArrowDown");
      webview.key(webview.row(STAGED_CHANGES_ID), "ArrowDown");

      expect(webview.document.activeElement).toBe(webview.row(A));
    });

    it("appends the rows Load more adds below the commits, not the working-change rows", () => {
      const host = new FakeHost();
      const webview = host.open({ workingChanges, rowLimit: 2 });

      webview.receive(host.update({ workingChanges, rowLimit: 4, revision: 8 }));

      expect(webview.document.querySelectorAll("tr.commit-row").map((row) => row.dataset.oid)).toEqual([UNSTAGED_CHANGES_ID, STAGED_CHANGES_ID, A, B, C, D]);
      expect(webview.document.querySelectorAll("tr.working-row").map((row) => row.dataset.oid)).toEqual([UNSTAGED_CHANGES_ID, STAGED_CHANGES_ID]);
    });

    it("replaces the working-change rows when their counts change, keeping the commit rows", () => {
      const host = new FakeHost();
      const webview = host.open({ workingChanges });
      const rowA = webview.row(A);

      webview.receive(host.update({ workingChanges: { ...workingChanges, staged: 3 }, revision: 8 }));

      expect(webview.row(A)).toBe(rowA);
      expect(webview.row(STAGED_CHANGES_ID).getAttribute("aria-label")).toBe("Staged changes, 3 files");
    });
  });

  describe("tooltips", () => {
    /** Visible buttons, inputs and selects without a tooltip, by ID or tag; a `hidden` one cannot be hovered. */
    function untitledControls(webview: FakeWebview): readonly string[] {
      return webview.document.descendants()
        .filter((element) => ["BUTTON", "INPUT", "SELECT"].includes(element.tagName) && !element.hidden)
        .filter((element) => element.title.trim() === "")
        .map((element) => element.id || element.tagName);
    }

    it("gives every working-change row and its cells a tooltip", () => {
      const webview = open({ workingChanges: { staged: 1, unstaged: 2, untracked: 1, conflicted: 1, isTruncated: false, contentKey: "k1" } });
      const rows = webview.document.querySelectorAll("tr.working-row");
      const filledCells = rows.flatMap((row) => row.descendants()).filter((element) => element.tagName === "TD" && element.childNodes.length > 0);

      expect(rows).toHaveLength(2);
      expect(filledCells).toHaveLength(6);
      expect([...rows, ...filledCells].filter((element) => element.title.trim() === "")).toEqual([]);
      expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Unstaged changes, 2 files", "Staged changes, 1 file"]);
    });

    it("gives every visible control a tooltip once the client runs", () => {
      const webview = open({ selectedOids: [A], focusedOid: A });

      expect(webview.document.querySelectorAll("button").length).toBeGreaterThan(5);
      expect(untitledControls(webview)).toEqual([]);
    });

    it("keeps every visible control's tooltip across updates", () => {
      const host = new FakeHost();
      const webview = host.open();

      webview.receive(host.update({ selectedOids: [A, B], focusedOid: B, revision: 8 }));
      expect(untitledControls(webview)).toEqual([]);

      webview.receive(host.update({ selectedOids: [], revision: 9 }));
      expect(untitledControls(webview)).toEqual([]);
      expect(webview.element("history-clear-selection").title).toBe("Nothing to clear: no commits are selected");
    });

    it("says what Clear does once an update enables it", () => {
      const host = new FakeHost();
      const webview = host.open();
      expect(webview.element("history-clear-selection").hasAttribute("disabled")).toBe(true);

      webview.receive(host.update({ selectedOids: [B], focusedOid: B, revision: 8 }));

      expect(webview.element("history-clear-selection").title).toBe("Deselect every commit");
    });
  });

  describe("updates", () => {
    it("marks the new selection on the rows it already shows and echoes the new revision", () => {
      const host = new FakeHost();
      const webview = host.open({ focusedOid: A });
      const rowB = webview.row(B);

      webview.receive(host.update({ selectedOids: [B], focusedOid: B, revision: 8 }));

      expect(webview.row(B)).toBe(rowB);
      expect(rowB.classList.contains("is-selected")).toBe(true);
      expect(rowB.getAttribute("aria-selected")).toBe("true");
      expect(rowB.classList.contains("is-focused")).toBe(true);
      expect(rowB.getAttribute("tabindex")).toBe("0");
      expect(webview.row(A).classList.contains("is-focused")).toBe(false);
      expect(webview.row(A).getAttribute("tabindex")).toBe("-1");
      expect(webview.element("history-clear-selection").hasAttribute("disabled")).toBe(false);
      webview.click(webview.row(D), { ctrlKey: true });
      expect(webview.last()).toEqual({ type: "select", revision: 8, oids: [B, D], focusedOid: D });
    });

    it("clears the marks of commits the host deselected", () => {
      const host = new FakeHost();
      const webview = host.open({ selectedOids: [B, C], focusedOid: C });

      webview.receive(host.update({ selectedOids: [C], focusedOid: C, revision: 8 }));

      expect(webview.row(B).classList.contains("is-selected")).toBe(false);
      expect(webview.row(B).getAttribute("aria-selected")).toBe("false");
      expect(webview.row(C).classList.contains("is-selected")).toBe(true);
    });

    it("shows the changed files of a new comparison and opens them", () => {
      const host = new FakeHost();
      const webview = host.open();

      webview.receive(host.update({ selectedOids: [B], focusedOid: B, revision: 8 }));
      const file = webview.find("button.file-row", (element) => element.dataset.fileId === FILE_ID);
      file.dispatch(new FakeEvent("dblclick", file));

      expect(webview.last()).toEqual({ type: "openFile", revision: 8, snapshotId: SNAPSHOT_ID, fileId: FILE_ID });
    });

    it("moves the open-file mark to the file a step opened and brings it into view", () => {
      const host = new FakeHost();
      const webview = host.open({ selectedOids: [B], openFileId: FILE_ID });
      const fileRow = (id: string): FakeElement => webview.find("button.file-row", (element) => element.dataset.fileId === id);
      expect(fileRow(FILE_ID).scrolledIntoView).toEqual([{ block: "nearest" }]);

      webview.receive(host.update({ selectedOids: [B], openFileId: OTHER_FILE_ID, revision: 8 }));

      expect(fileRow(FILE_ID).classList.contains("is-open")).toBe(false);
      expect(fileRow(FILE_ID).hasAttribute("aria-current")).toBe(false);
      expect(fileRow(OTHER_FILE_ID).classList.contains("is-open")).toBe(true);
      expect(fileRow(OTHER_FILE_ID).scrolledIntoView).toEqual([{ block: "nearest" }]);
      expect(fileRow(FILE_ID).scrolledIntoView).toHaveLength(1);
    });

    it("moves the open-file mark on an opened-file message, keeping the revision intents carry", () => {
      const host = new FakeHost();
      const webview = host.open({ selectedOids: [B], openFileId: FILE_ID });
      const fileRow = (id: string): FakeElement => webview.find("button.file-row", (element) => element.dataset.fileId === id);

      webview.receive({ type: "openedFile", revision: 7, openedFile: { snapshotId: SNAPSHOT_ID, fileId: OTHER_FILE_ID } });

      expect(fileRow(FILE_ID).classList.contains("is-open")).toBe(false);
      expect(fileRow(OTHER_FILE_ID).classList.contains("is-open")).toBe(true);
      expect(fileRow(OTHER_FILE_ID).scrolledIntoView).toEqual([{ block: "nearest" }]);
      fileRow(FILE_ID).dispatch(new FakeEvent("dblclick", fileRow(FILE_ID)));
      expect(webview.last()).toEqual({ type: "openFile", revision: 7, snapshotId: SNAPSHOT_ID, fileId: FILE_ID });
    });

    it("ignores an opened-file message sent to another revision, and unmarks a file of another snapshot", () => {
      const host = new FakeHost();
      const webview = host.open({ selectedOids: [B], openFileId: FILE_ID });
      const fileRow = (id: string): FakeElement => webview.find("button.file-row", (element) => element.dataset.fileId === id);

      webview.receive({ type: "openedFile", revision: 6, openedFile: { snapshotId: SNAPSHOT_ID, fileId: OTHER_FILE_ID } });
      expect(fileRow(FILE_ID).classList.contains("is-open")).toBe(true);
      webview.receive({ type: "openedFile", revision: 7, openedFile: { snapshotId: "another-snapshot", fileId: OTHER_FILE_ID } });

      expect(fileRow(FILE_ID).classList.contains("is-open")).toBe(false);
      expect(fileRow(OTHER_FILE_ID).classList.contains("is-open")).toBe(false);
    });

    it("deselects the file whose diff tab closed, leaving it neither marked nor focused", () => {
      const host = new FakeHost();
      const webview = host.open({ selectedOids: [B] });
      const opened = webview.find("button.file-row", (element) => element.dataset.fileId === FILE_ID);
      webview.click(opened);
      opened.dispatch(new FakeEvent("dblclick", opened));
      webview.receive(host.update({ selectedOids: [B], openFileId: FILE_ID, revision: 8 }));

      webview.receive(host.update({ selectedOids: [B], openFileId: null, revision: 9 }));

      expect(opened.classList.contains("is-open")).toBe(false);
      expect(opened.hasAttribute("aria-current")).toBe(false);
      expect(webview.document.activeElement).toBeNull();
      expect(webview.state).toMatchObject({ activeKey: null });
    });

    it("leaves the focus on another file when the open file's tab closes", () => {
      const host = new FakeHost();
      const webview = host.open({ selectedOids: [B], openFileId: FILE_ID });
      const other = webview.find("button.file-row", (element) => element.dataset.fileId === OTHER_FILE_ID);
      other.focus();

      webview.receive(host.update({ selectedOids: [B], openFileId: null, revision: 8 }));

      expect(webview.document.activeElement).toBe(other);
      expect(webview.state).toMatchObject({ activeKey: `file:${OTHER_FILE_ID}` });
    });

    it("appends the rows Load more adds and moves through them with arrow keys", () => {
      const host = new FakeHost();
      const webview = host.open({ rowLimit: 2, focusedOid: B });
      const rowA = webview.row(A);
      webview.row(B).focus();

      const update = host.update({ rowLimit: 4, focusedOid: B, revision: 8 });
      webview.receive(update);
      webview.key(webview.row(B), "ArrowDown");
      webview.key(webview.row(C), "ArrowDown");

      expect(update.appendedRows).not.toBe("");
      expect(webview.row(A)).toBe(rowA);
      expect(webview.document.querySelectorAll("tr.commit-row").map((row) => row.dataset.oid)).toEqual([A, B, C, D]);
      expect(webview.document.activeElement).toBe(webview.row(D));
      expect(webview.element("history-load-more").dataset.rowLimit).toBe(String(4 + HISTORY_PAGE_SIZE));
    });

    it("replaces the rows when the filters change and selects ranges over the new ones", () => {
      const host = new FakeHost();
      const webview = host.open({ focusedOid: B });
      const rowB = webview.row(B);
      webview.click(rowB);

      webview.receive(host.update({ visibleOids: [B, D, E], selectedOids: [B], focusedOid: B, revision: 8 }));
      webview.click(webview.row(E), { shiftKey: true });

      expect(rowB.isConnected).toBe(false);
      expect(webview.document.querySelectorAll("tr.commit-row").map((row) => row.dataset.oid)).toEqual([B, D, E]);
      expect(webview.last()).toEqual({ type: "select", revision: 8, oids: [B, D, E], focusedOid: E });
    });

    it("moves keyboard focus to the replacement of a control it replaces", () => {
      const host = new FakeHost();
      const webview = host.open({ selectedOids: [B], focusedOid: B });
      const clear = webview.element("history-clear-selection");
      clear.focus();

      webview.receive(host.update({ selectedOids: [B, C], focusedOid: B, revision: 8 }));

      expect(clear.isConnected).toBe(false);
      expect(webview.document.activeElement).toBe(webview.element("history-clear-selection"));
    });

    it("keeps keyboard focus on the row when the rows are replaced", () => {
      const host = new FakeHost();
      const webview = host.open({ focusedOid: B });
      webview.row(B).focus();

      webview.receive(host.update({ visibleOids: [B, D], focusedOid: B, revision: 8 }));

      expect(webview.document.activeElement).toBe(webview.row(B));
    });

    it("keeps search text being typed and sends it with the new revision", () => {
      const host = new FakeHost();
      const webview = host.open();
      const search = webview.element("history-search");
      search.focus();
      webview.type(search, "bra");

      webview.receive(host.update({ selectedOids: [B], focusedOid: B, revision: 8 }));
      vi.advanceTimersByTime(150);

      expect(webview.element("history-search")).toBe(search);
      expect(search.value).toBe("bra");
      expect(webview.document.activeElement).toBe(search);
      expect(webview.last()).toEqual({ type: "presentation", revision: 8, search: "bra", branch: null, focusedOid: B, rowLimit: HISTORY_PAGE_SIZE });
    });

    it("resends a search an update overtook, and drops it once the host shows it", () => {
      const host = new FakeHost();
      const webview = host.open();
      webview.type(webview.element("history-search"), "bra");
      vi.advanceTimersByTime(150);

      webview.receive(host.update({ selectedOids: [B], focusedOid: B, revision: 8 }));
      vi.advanceTimersByTime(150);
      webview.receive(host.update({ selectedOids: [B], focusedOid: B, search: "bra", visibleOids: [B], revision: 9 }));
      vi.advanceTimersByTime(500);

      expect(webview.intents().map((message) => [message.revision, message.search])).toEqual([[7, "bra"], [8, "bra"]]);
      expect(webview.state).toMatchObject({ searchDraft: null });
    });

    it("keeps an unsent arrow focus across an update", () => {
      const host = new FakeHost();
      const webview = host.open({ focusedOid: B });
      webview.key(webview.row(B), "ArrowDown");

      webview.receive(host.update({ selectedOids: [A], focusedOid: B, revision: 8 }));
      vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);

      expect(webview.row(C).classList.contains("is-focused")).toBe(true);
      expect(webview.row(B).classList.contains("is-focused")).toBe(false);
      expect(webview.intents()).toEqual([
        { type: "presentation", revision: 8, search: "", branch: null, focusedOid: C, rowLimit: HISTORY_PAGE_SIZE },
      ]);
    });

    it("forgets anchor, scroll and drafts when the update shows another repository", () => {
      const host = new FakeHost();
      const webview = host.open({ focusedOid: B });
      const pane = webview.document.querySelector(".commit-pane")!;
      pane.scrollTop = 80;
      webview.click(webview.row(B));
      webview.type(webview.element("history-search"), "x");

      webview.receive(host.update({ repositoryId: OTHER_REPOSITORY_ID, revision: 8 }));
      vi.advanceTimersByTime(500);

      expect(pane.scrollTop).toBe(0);
      expect(webview.element("history-search").value).toBe("");
      expect(webview.state).toMatchObject({ repositoryId: OTHER_REPOSITORY_ID, anchorOid: null, searchDraft: null });
      expect(webview.intents().filter((message) => message.type === "presentation")).toEqual([]);
    });

    it("ignores an update no newer than the shown page", () => {
      const host = new FakeHost();
      const webview = host.open({ revision: 7 });

      webview.receive(host.update({ selectedOids: [B], revision: 7 }));
      webview.click(webview.row(C), { ctrlKey: true });

      expect(webview.row(B).classList.contains("is-selected")).toBe(false);
      expect(webview.last()).toEqual({ type: "select", revision: 7, oids: [C], focusedOid: C });
    });
  });
});
