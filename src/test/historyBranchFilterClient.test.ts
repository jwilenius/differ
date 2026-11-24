import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_PAGE_SIZE } from "../render/html/historyRenderer";
import {
  A,
  B,
  C,
  BRANCHES,
  FakeEvent,
  FakeHost,
  FakeWebview,
  marked,
  open,
  OTHER_REPOSITORY_ID,
  publish,
} from "./historyClientFixture";

interface FuzzyMatch {
  readonly isFuzzyMatch: (...args: unknown[]) => boolean;
  readonly fuzzyMatchRanges: (...args: unknown[]) => unknown;
}

/** Wraps the client's `fuzzyMatch` global to count the match tests and the mark searches. */
function countFuzzyMatchCalls(webview: FakeWebview): { isFuzzyMatch: number; fuzzyMatchRanges: number } {
  const calls = { isFuzzyMatch: 0, fuzzyMatchRanges: 0 };
  const fuzzyMatch = webview.globals.fuzzyMatch as FuzzyMatch;
  webview.globals.fuzzyMatch = {
    ...fuzzyMatch,
    isFuzzyMatch: (...args: unknown[]) => {
      calls.isFuzzyMatch++;
      return fuzzyMatch.isFuzzyMatch(...args);
    },
    fuzzyMatchRanges: (...args: unknown[]) => {
      calls.fuzzyMatchRanges++;
      return fuzzyMatch.fuzzyMatchRanges(...args);
    },
  };
  return calls;
}

describe("history branch filter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens on a click with every branch, the chosen one active and checked", () => {
    const webview = open({ refs: BRANCHES, branch: { ref: "refs/heads/fix/bug", tipOid: C } });
    const input = webview.element("history-branch-input");

    expect(input.placeholder).toBe("fix/bug");
    webview.click(input);

    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(webview.element("history-branch-list").hidden).toBe(false);
    expect(webview.branchOptions()).toEqual(["All branches", "Checked out branch", "main", "feature/branch-filter", "fix/bug", "origin/main"]);
    expect(webview.activeBranch()).toBe("fix/bug");
    expect(webview.document.querySelectorAll("li.is-chosen").map(marked)).toEqual(["fix/bug"]);
    expect(webview.element("history-branch-option-4").getAttribute("aria-selected")).toBe("true");
    expect(webview.element("history-branch-option-4").getAttribute("aria-posinset")).toBe("5");
    expect(webview.element("history-branch-option-4").getAttribute("aria-setsize")).toBe("6");
  });

  it("opens with Enter, Space, Down and Alt+Down, and closes with Escape", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    const list = webview.element("history-branch-list");

    for (const [key, init] of [["Enter", {}], [" ", {}], ["ArrowDown", {}], ["ArrowDown", { altKey: true }]] as const) {
      expect(webview.key(input, key, init).defaultPrevented).toBe(true);
      expect(list.hidden).toBe(false);
      expect(webview.key(input, "Escape").defaultPrevented).toBe(true);
      expect(list.hidden).toBe(true);
      expect(input.getAttribute("aria-expanded")).toBe("false");
    }
    expect(webview.key(input, "a").defaultPrevented).toBe(false);
    expect(webview.intents()).toEqual([]);
  });

  it("closes with Alt+Up and leaves keys composing text to the input method", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    const list = webview.element("history-branch-list");

    expect(webview.key(input, "Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(list.hidden).toBe(true);
    webview.click(input);
    expect(webview.key(input, "Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(list.hidden).toBe(false);
    expect(webview.key(input, "ArrowUp", { altKey: true }).defaultPrevented).toBe(true);
    expect(list.hidden).toBe(true);
    expect(webview.intents()).toEqual([]);
  });

  it("opens when typing, keeps the branches with the letters in order and marks them", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    input.focus();

    webview.type(input, "FB");

    expect(webview.element("history-branch-list").hidden).toBe(false);
    expect(webview.branchOptions()).toEqual(["[f]eature/[b]ranch-filter", "[f]ix/[b]ug"]);
    expect(webview.activeBranch()).toBe("[f]eature/[b]ranch-filter");
    expect(input.getAttribute("aria-activedescendant")).toBe("history-branch-option-0");
  });

  it("matches the fixed entries by their labels and shows all for an empty query", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    webview.click(input);

    webview.type(input, "cob");
    expect(webview.branchOptions()).toEqual(["[C]hecked [o]ut [b]ranch"]);
    webview.type(input, "");
    expect(webview.branchOptions()).toHaveLength(6);
  });

  it("closes without picking on Enter when no branch matches", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    webview.click(input);

    webview.type(input, "zz");
    webview.key(input, "Enter");

    expect(webview.branchOptions()).toEqual([]);
    expect(webview.element("history-branch-list").hidden).toBe(true);
    expect(webview.intents()).toEqual([]);
  });

  it("lists no match as a note, not an option", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    webview.click(input);

    webview.type(input, "zz");

    expect(webview.document.querySelectorAll("li.branch-empty").map(marked)).toEqual(["No matching branches"]);
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("moves the active option with the arrows, stopping at the ends, and picks it with Enter", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    webview.click(input);
    webview.type(input, "i");

    webview.key(input, "ArrowUp");
    expect(webview.activeBranch()).toBe("ma[i]n");
    for (let step = 0; step < 10; step++) {
      webview.key(input, "ArrowDown");
    }
    expect(webview.activeBranch()).toBe("or[i]gin/main");
    webview.key(input, "ArrowUp");
    expect(webview.element("history-branch-option-2").scrolledIntoView).toContainEqual({ block: "nearest" });
    expect(webview.key(input, "Enter").defaultPrevented).toBe(true);

    expect(webview.last()).toEqual({ type: "presentation", revision: 7, search: "", branch: "refs/heads/fix/bug", focusedOid: null, rowLimit: HISTORY_PAGE_SIZE });
    expect(webview.element("history-branch-list").hidden).toBe(true);
    expect(input.value).toBe("fix/bug");
    expect(input.placeholder).toBe("fix/bug");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("clears the query when Escape closes the list", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    webview.click(input);
    webview.type(input, "fb");

    webview.key(input, "Escape");
    webview.click(input);

    expect(input.value).toBe("");
    expect(webview.branchOptions()).toHaveLength(6);
    expect(webview.intents()).toEqual([]);
  });

  it("names the chosen branch in the value while closed and clears it on opening", () => {
    const webview = open({ refs: BRANCHES, branch: { ref: "refs/heads/fix/bug", tipOid: C } });
    const input = webview.element("history-branch-input");

    expect(input.value).toBe("fix/bug");
    webview.key(input, "ArrowDown");

    expect(input.value).toBe("");
    expect(input.placeholder).toBe("fix/bug");
    expect(webview.activeBranch()).toBe("fix/bug");
  });

  it("names the chosen branch in the input's tooltip and each branch in its option's", () => {
    const webview = open({ refs: BRANCHES, branch: { ref: "refs/heads/fix/bug", tipOid: C } });
    const input = webview.element("history-branch-input");

    expect(input.title).toBe("Branch filter: fix/bug. Click or type to choose another branch; ↑/↓ move, Enter picks, Escape closes");
    webview.click(input);

    expect(webview.element("history-branch-list").querySelectorAll("li").map((option) => option.title))
      .toEqual(["All branches", "Checked out branch", "main", "feature/branch-filter", "fix/bug", "origin/main"]);
  });

  it("names a picked branch in the input's tooltip at once", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    expect(input.title).toMatch(/^Branch filter: All branches\./);

    webview.pickBranch("bug");

    expect(input.title).toMatch(/^Branch filter: fix\/bug\./);
  });

  it("restores the chosen branch's name when Escape closes the list on a query", () => {
    const webview = open({ refs: BRANCHES, branch: { ref: "refs/heads/fix/bug", tipOid: C } });
    const input = webview.element("history-branch-input");
    webview.click(input);
    webview.type(input, "mn");

    webview.key(input, "Escape");

    expect(input.value).toBe("fix/bug");
    expect(webview.intents()).toEqual([]);
  });

  it("starts a fresh query with text typed into the closed input", () => {
    const webview = open({ refs: BRANCHES, branch: { ref: "refs/heads/fix/bug", tipOid: C } });
    const input = webview.element("history-branch-input");

    input.value = "fix/bugo";
    input.dispatch(new FakeEvent("input", input, { inputType: "insertText", data: "o" }));

    expect(input.value).toBe("o");
    expect(webview.branchOptions()).toEqual(["Checked [o]ut branch", "[o]rigin/main"]);
    expect(webview.activeBranch()).toBe("Checked [o]ut branch");
  });

  it("opens every branch on the chosen one when a deletion edits the closed input", () => {
    const webview = open({ refs: BRANCHES, branch: { ref: "refs/heads/fix/bug", tipOid: C } });
    const input = webview.element("history-branch-input");

    input.value = "fix/bu";
    input.dispatch(new FakeEvent("input", input, { inputType: "deleteContentBackward", data: null }));

    expect(input.value).toBe("");
    expect(webview.branchOptions()).toHaveLength(6);
    expect(webview.activeBranch()).toBe("fix/bug");
  });

  it("starts a fresh query with text composed into the closed input once the input method commits it", () => {
    const webview = open({ refs: BRANCHES, branch: { ref: "refs/heads/fix/bug", tipOid: C } });
    const input = webview.element("history-branch-input");
    const list = webview.element("history-branch-list");

    input.value = "fix/bugo";
    input.dispatch(new FakeEvent("input", input, { inputType: "insertCompositionText", data: "o", isComposing: true }));
    expect(list.hidden).toBe(true);
    input.dispatch(new FakeEvent("compositionend", input, { data: "o" }));

    expect(input.value).toBe("o");
    expect(webview.branchOptions()).toEqual(["Checked [o]ut branch", "[o]rigin/main"]);
  });

  it("picks a clicked option without the press taking the focus", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    webview.click(input);
    webview.type(input, "fb");
    const option = webview.find("li.branch-option", (element) => marked(element) === "[f]ix/[b]ug");

    expect(webview.press(option).defaultPrevented).toBe(true);
    webview.click(option);

    expect(webview.last()).toMatchObject({ type: "presentation", branch: "refs/heads/fix/bug" });
    expect(webview.element("history-branch-list").hidden).toBe(true);
    expect(input.value).toBe("fix/bug");
  });

  it("closes without picking when the focus leaves", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    webview.click(input);
    webview.type(input, "fb");

    webview.element("history-search").focus();

    expect(webview.element("history-branch-list").hidden).toBe(true);
    expect(input.value).toBe("All branches");
    expect(webview.intents()).toEqual([]);
  });

  it("sends nothing when the chosen branch is picked again", () => {
    const webview = open({ refs: BRANCHES });

    webview.pickBranch("all");

    expect(webview.intents()).toEqual([]);
  });

  it("places the list below the input, within the panel", () => {
    const webview = open({ refs: BRANCHES });

    webview.click(webview.element("history-branch-input"));

    const style = webview.element("history-branch-list").style as unknown as Record<string, string>;
    expect([style.top, style.bottom, style.left, style.minWidth, style.maxHeight]).toEqual(["22px", "auto", "2px", "100px", "576px"]);
  });

  it("shows branch names as text, never as markup", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const webview = open({ refs: [{ kind: "localBranch", name: hostile, oid: A }] });
    const input = webview.element("history-branch-input");
    webview.click(input);

    webview.type(input, "img");

    expect(webview.branchOptions()).toEqual(["<[img] src=x onerror=alert(1)>"]);
    expect(webview.document.querySelectorAll("img")).toEqual([]);
  });

  it("adds options for thousands of branches a page at a time", () => {
    const many = Array.from({ length: 5000 }, (_, index) => ({ kind: "remoteBranch" as const, name: `origin/feature-${index}`, oid: A }));
    const webview = open({ refs: many });
    const input = webview.element("history-branch-input");
    const list = webview.element("history-branch-list");
    webview.click(input);

    expect(webview.branchOptions()).toHaveLength(100);
    for (let step = 0; step < 100; step++) {
      webview.key(input, "ArrowDown");
    }
    expect(webview.branchOptions()).toHaveLength(200);
    expect(webview.activeBranch()).toBe("origin/feature-98");
    list.dispatch(new FakeEvent("scroll", list));
    expect(webview.branchOptions()).toHaveLength(300);
    expect(webview.element("history-branch-option-0").getAttribute("aria-setsize")).toBe("5002");
  });

  it("tests each offered branch once per query and marks only the shown options", () => {
    const many = Array.from({ length: 10_000 }, (_, index) => ({ kind: "remoteBranch" as const, name: `origin/feature-${index}`, oid: A }));
    const webview = open({ refs: many });
    const input = webview.element("history-branch-input");
    const calls = countFuzzyMatchCalls(webview);
    webview.click(input);
    calls.isFuzzyMatch = 0;
    calls.fuzzyMatchRanges = 0;

    webview.type(input, "f9");

    expect(calls).toEqual({ isFuzzyMatch: 10_002, fuzzyMatchRanges: 100 });
    expect(webview.branchOptions()).toHaveLength(100);
  });

  it("leaves the list alone when scrolling finds every match already shown", () => {
    const webview = open({ refs: BRANCHES });
    const input = webview.element("history-branch-input");
    const list = webview.element("history-branch-list");
    webview.click(input);
    const reads = input.boundingRectReads;

    list.dispatch(new FakeEvent("scroll", list));

    expect(input.boundingRectReads).toBe(reads);
    expect(webview.branchOptions()).toHaveLength(6);
  });

  describe("local branches only", () => {
    it("starts released", () => {
      const webview = open({ refs: BRANCHES });

      expect(webview.element("history-branch-local-only").getAttribute("aria-pressed")).toBe("false");
    });

    it("says in its tooltip what a click does now", () => {
      const webview = open({ refs: BRANCHES });
      const toggle = webview.element("history-branch-local-only");
      expect(toggle.title).toMatch(/^Show local branches only in the branch list/);

      webview.click(toggle);
      expect(toggle.title).toMatch(/^Showing local branches only in the branch list; click to list remote branches too/);
      expect(toggle.getAttribute("aria-label")).toBe("Show local branches only");

      webview.click(toggle);
      expect(toggle.title).toMatch(/^Show local branches only in the branch list/);
    });

    it("leaves out remote branches while pressed, keeping All branches and Checked out branch", () => {
      const webview = open({ refs: BRANCHES });
      const toggle = webview.element("history-branch-local-only");

      webview.click(toggle);
      webview.click(webview.element("history-branch-input"));

      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      expect(webview.branchOptions()).toEqual(["All branches", "Checked out branch", "main", "feature/branch-filter", "fix/bug"]);
      expect(webview.element("history-branch-option-0").getAttribute("aria-setsize")).toBe("5");
      expect(webview.intents()).toEqual([]);
    });

    it("offers remote branches again once released", () => {
      const webview = open({ refs: BRANCHES });
      const toggle = webview.element("history-branch-local-only");

      webview.click(toggle);
      webview.click(toggle);
      webview.click(webview.element("history-branch-input"));

      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      expect(webview.branchOptions()).toHaveLength(6);
    });

    it("matches typed text among the local branches only", () => {
      const webview = open({ refs: BRANCHES });
      const input = webview.element("history-branch-input");
      webview.click(webview.element("history-branch-local-only"));
      webview.click(input);

      webview.type(input, "mn");
      expect(webview.branchOptions()).toEqual(["[m]ai[n]"]);
      webview.type(input, "orig");
      expect(webview.branchOptions()).toEqual(["No matching branches"]);
    });

    it("keeps a chosen remote branch shown without offering it", () => {
      const webview = open({ refs: BRANCHES, branch: { ref: "refs/remotes/origin/main", tipOid: A } });
      const input = webview.element("history-branch-input");

      webview.click(webview.element("history-branch-local-only"));
      webview.click(input);

      expect(input.placeholder).toBe("origin/main");
      expect(webview.branchOptions()).not.toContain("origin/main");
      expect(webview.document.querySelectorAll("li.is-chosen")).toEqual([]);
      webview.key(input, "Escape");
      expect(input.placeholder).toBe("origin/main");
      expect(webview.intents()).toEqual([]);
    });

    it("opens with no option active when it leaves out the chosen branch, so Enter, Enter picks nothing", () => {
      const webview = open({ refs: BRANCHES, branch: { ref: "refs/remotes/origin/main", tipOid: A } });
      const input = webview.element("history-branch-input");
      const list = webview.element("history-branch-list");
      webview.click(webview.element("history-branch-local-only"));
      input.focus();

      webview.key(input, "Enter");
      expect(list.hidden).toBe(false);
      expect(webview.activeBranch()).toBeNull();
      expect(webview.document.querySelectorAll("li.is-active")).toEqual([]);
      webview.key(input, "Enter");

      expect(list.hidden).toBe(true);
      expect(input.placeholder).toBe("origin/main");
      expect(webview.intents()).toEqual([]);
    });

    it("makes the first option active with either arrow when none is", () => {
      const webview = open({ refs: BRANCHES, branch: { ref: "refs/remotes/origin/main", tipOid: A } });
      const input = webview.element("history-branch-input");
      webview.click(webview.element("history-branch-local-only"));

      webview.click(input);
      webview.key(input, "ArrowDown");
      expect(webview.activeBranch()).toBe("All branches");
      webview.key(input, "Escape");
      webview.click(input);
      webview.key(input, "ArrowUp");
      expect(webview.activeBranch()).toBe("All branches");
      webview.key(input, "ArrowDown");
      webview.key(input, "Enter");

      expect(webview.last()).toMatchObject({ type: "presentation", branch: "checked-out" });
    });

    it("makes the first match active once text is typed, and moves on from it with the arrows", () => {
      const webview = open({ refs: BRANCHES, branch: { ref: "refs/remotes/origin/main", tipOid: A } });
      const input = webview.element("history-branch-input");
      webview.click(webview.element("history-branch-local-only"));
      webview.click(input);

      webview.type(input, "i");
      expect(webview.activeBranch()).toBe("ma[i]n");
      webview.key(input, "ArrowDown");
      expect(webview.activeBranch()).toBe("feature/branch-f[i]lter");
      webview.key(input, "Enter");

      expect(webview.last()).toMatchObject({ type: "presentation", branch: "refs/heads/feature/branch-filter" });
    });

    it("stays pressed in a document recreated after the panel was hidden", () => {
      const first = open({ refs: BRANCHES });
      first.click(first.element("history-branch-local-only"));

      const second = new FakeWebview();
      second.state = first.state;
      second.load(publish({ refs: BRANCHES, revision: 8 }));
      second.click(second.element("history-branch-input"));

      expect(second.element("history-branch-local-only").getAttribute("aria-pressed")).toBe("true");
      expect(second.branchOptions()).not.toContain("origin/main");
    });

    it("stays pressed in a document recreated for another repository", () => {
      const first = open({ refs: BRANCHES });
      first.click(first.element("history-branch-local-only"));

      const second = new FakeWebview();
      second.state = first.state;
      second.load(publish({ refs: BRANCHES, repositoryId: OTHER_REPOSITORY_ID, revision: 8 }));

      expect(second.element("history-branch-local-only").getAttribute("aria-pressed")).toBe("true");
    });
  });

  describe("updates", () => {
    it("shows the host's branch choice again when it did not take a pick", () => {
      const host = new FakeHost();
      const webview = host.open();
      webview.pickBranch("main");
      expect(webview.element("history-branch-input").placeholder).toBe("main");

      webview.receive(host.update({ selectedOids: [B], focusedOid: B, revision: 8 }));

      expect(webview.element("history-branch-input").placeholder).toBe("All branches");
    });

    it("names the host's branch choice in the input's tooltip after an update", () => {
      const host = new FakeHost();
      const webview = host.open({ refs: BRANCHES });

      webview.receive(host.update({ refs: BRANCHES, branch: { ref: "refs/heads/main", tipOid: A }, revision: 8 }));

      expect(webview.element("history-branch-input").title).toMatch(/^Branch filter: main\./);
    });

    it("keeps an open branch list, its query, active option and focus across an update", () => {
      const host = new FakeHost();
      const webview = host.open({ refs: BRANCHES });
      const input = webview.element("history-branch-input");
      const list = webview.element("history-branch-list");
      webview.click(input);
      webview.type(input, "mn");
      webview.key(input, "ArrowDown");

      webview.receive(host.update({ refs: BRANCHES, selectedOids: [B], focusedOid: B, revision: 8 }));

      expect(webview.element("history-branch-input")).toBe(input);
      expect(webview.document.activeElement).toBe(input);
      expect(input.value).toBe("mn");
      expect(list.hidden).toBe(false);
      expect(webview.branchOptions()).toEqual(["[m]ai[n]", "origin/[m]ai[n]"]);
      expect(webview.activeBranch()).toBe("origin/[m]ai[n]");
    });

    it("keeps the chosen branch marked when an update replaces the branches under an open list", () => {
      const host = new FakeHost();
      const webview = host.open({ refs: BRANCHES });
      const select = webview.element("history-branch");
      webview.click(webview.element("history-branch-input"));
      const chosen = webview.document.querySelectorAll("li.is-chosen").map(marked);

      webview.receive(host.update({ refs: [...BRANCHES, { kind: "localBranch", name: "new", oid: B }], revision: 8 }));

      expect(webview.element("history-branch")).not.toBe(select);
      expect(chosen).toHaveLength(1);
      expect(webview.document.querySelectorAll("li.is-chosen").map(marked)).toEqual(chosen);
    });

    it("refilters an open branch list when an update changes the branches, keeping the active one", () => {
      const host = new FakeHost();
      const webview = host.open({ refs: BRANCHES });
      const input = webview.element("history-branch-input");
      webview.click(input);
      webview.type(input, "mn");
      webview.key(input, "ArrowDown");

      webview.receive(host.update({ refs: [{ kind: "localBranch", name: "maintenance", oid: B }, ...BRANCHES.slice(2)], revision: 8 }));
      webview.key(input, "Enter");

      expect(webview.branchOptions()).toEqual([]);
      expect(webview.last()).toMatchObject({ type: "presentation", revision: 8, branch: "refs/remotes/origin/main" });
    });

    it("keeps no option active when an update replaces the branches under a list leaving out the chosen one", () => {
      const host = new FakeHost();
      const remoteChoice = { refs: BRANCHES, branch: { ref: "refs/remotes/origin/main", tipOid: A } };
      const webview = host.open(remoteChoice);
      const input = webview.element("history-branch-input");
      webview.click(webview.element("history-branch-local-only"));
      webview.click(input);

      webview.receive(host.update({ ...remoteChoice, refs: [...BRANCHES, { kind: "localBranch", name: "new", oid: B }], revision: 8 }));
      expect(webview.branchOptions()).toContain("new");
      expect(webview.activeBranch()).toBeNull();
      webview.key(input, "Enter");

      expect(webview.intents()).toEqual([]);
    });

    it("leaves no option active when an update removes the active one", () => {
      const host = new FakeHost();
      const webview = host.open({ refs: BRANCHES });
      const input = webview.element("history-branch-input");
      webview.click(input);
      webview.type(input, "mn");
      webview.key(input, "ArrowDown");

      webview.receive(host.update({ refs: BRANCHES.slice(0, 3), revision: 8 }));
      expect(webview.branchOptions()).toEqual(["[m]ai[n]"]);
      expect(webview.activeBranch()).toBeNull();
      webview.key(input, "Enter");

      expect(webview.intents()).toEqual([]);
    });

    it("keeps local branches only across an update that replaces the branches under an open list", () => {
      const host = new FakeHost();
      const webview = host.open({ refs: BRANCHES });
      const input = webview.element("history-branch-input");
      webview.click(webview.element("history-branch-local-only"));
      webview.click(input);
      webview.type(input, "mn");

      webview.receive(host.update({ refs: [...BRANCHES, { kind: "remoteBranch", name: "origin/maintenance", oid: B }], revision: 8 }));

      expect(webview.element("history-branch-local-only").getAttribute("aria-pressed")).toBe("true");
      expect(webview.branchOptions()).toEqual(["[m]ai[n]"]);
    });

    it("keeps local branches only when the update shows another repository", () => {
      const host = new FakeHost();
      const webview = host.open({ refs: BRANCHES });
      webview.click(webview.element("history-branch-local-only"));

      webview.receive(host.update({ refs: BRANCHES, repositoryId: OTHER_REPOSITORY_ID, revision: 8 }));
      webview.click(webview.element("history-branch-input"));

      expect(webview.element("history-branch-local-only").getAttribute("aria-pressed")).toBe("true");
      expect(webview.branchOptions()).not.toContain("origin/main");
    });
  });
});
