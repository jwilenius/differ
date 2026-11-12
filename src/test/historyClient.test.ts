import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_PAGE_SIZE, HtmlHistoryRenderer } from "../render/html/historyRenderer";
import type { HistoryRenderContext } from "../render/html/historyRenderer";
import type { ComparisonFile, HistoryCommit, HistoryData, HistoryState } from "../model/historyTypes";

const CLIENT_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "media", "history.js"), "utf8");

// ------------------------------------------------- minimal DOM fixture

const FOCUSABLE_TAGS = new Set(["TR", "BUTTON", "INPUT", "SELECT"]);
const VOID_TAGS = new Set(["meta", "link", "input", "br", "img", "hr"]);
const TOKEN_PATTERN = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:="[^"]*")?)*)\s*(\/?)>/g;
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g;
const SELECTOR_PATTERN = /^([a-z0-9]*)((?:\.[-\w]+)*)$/;
const FRAME_MS = 16;
const FOCUS_DEBOUNCE_MS = 250;

type Listener = (event: FakeEvent) => void;

interface EventInit {
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

class FakeEvent {
  defaultPrevented = false;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;

  constructor(readonly type: string, readonly target: FakeElement, init: EventInit = {}) {
    this.key = init.key ?? "";
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeEventTarget {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  notify(event: FakeEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
  }
}

/** Inline style: `width` as the resize grip writes it, plus custom properties. */
class FakeStyle {
  width = "";
  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? "";
  }

  removeProperty(name: string): void {
    if (name === "width") {
      this.width = "";
    }
    this.properties.delete(name);
  }
}

class FakeElement extends FakeEventTarget {
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  scrollTop = 0;
  selectionStart = 0;
  selectionEnd = 0;
  readonly style = new FakeStyle();
  private currentValue: string | null = null;

  constructor(readonly owner: FakeDocument | null, readonly tagName: string, readonly attributes: Map<string, string>) {
    super();
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  get dataset(): Record<string, string> {
    const entries = [...this.attributes]
      .filter(([name]) => name.startsWith("data-"))
      .map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()), value]);
    return Object.fromEntries(entries);
  }

  get value(): string {
    if (this.currentValue !== null) {
      return this.currentValue;
    }
    if (this.tagName === "SELECT") {
      const options = this.descendants().filter((element) => element.tagName === "OPTION");
      const chosen = options.find((option) => option.attributes.has("selected")) ?? options[0];
      return chosen?.attributes.get("value") ?? "";
    }
    return this.attributes.get("value") ?? "";
  }

  set value(value: string) {
    this.currentValue = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  get classList(): { toggle(name: string, force: boolean): void; contains(name: string): boolean } {
    const classes = (): string[] => (this.attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
    return {
      toggle: (name, force) => {
        const kept = classes().filter((candidate) => candidate !== name);
        this.attributes.set("class", (force ? [...kept, name] : kept).join(" "));
      },
      contains: (name) => classes().includes(name),
    };
  }

  matches(selector: string): boolean {
    const match = SELECTOR_PATTERN.exec(selector);
    if (!match) {
      throw new Error(`Unsupported selector in fixture: ${selector}`);
    }
    const [, tag, classPart] = match;
    const classes = (this.attributes.get("class") ?? "").split(/\s+/);
    const isTagMatch = tag === "" || this.tagName === tag!.toUpperCase();
    return isTagMatch && classPart!.split(".").filter(Boolean).every((name) => classes.includes(name));
  }

  closest(selector: string): FakeElement | null {
    for (let element: FakeElement | null = this; element; element = element.parent) {
      if (element.tagName !== "#document" && element.matches(selector)) {
        return element;
      }
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((element) => element.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  focus(): void {
    this.owner!.activeElement = this;
    this.dispatch(new FakeEvent("focusin", this));
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  dispatch(event: FakeEvent): void {
    for (let element: FakeElement | null = this; element; element = element.parent) {
      element.notify(event);
    }
  }
}

class FakeDocument extends FakeElement {
  activeElement: FakeElement | null = null;
  body!: FakeElement;

  constructor() {
    super(null, "#document", new Map());
  }

  getElementById(id: string): FakeElement | null {
    return this.descendants().find((element) => element.id === id) ?? null;
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Parses the renderer's well-formed output: elements and double-quoted attributes only. */
function parseDocument(html: string): FakeDocument {
  const document = new FakeDocument();
  const stack: FakeElement[] = [document];
  for (const token of html.matchAll(TOKEN_PATTERN)) {
    const [, closingTag, openingTag, attributeText, selfClosing] = token;
    if (closingTag) {
      const index = stack.map((element) => element.tagName).lastIndexOf(closingTag.toUpperCase());
      stack.length = Math.max(1, index);
      continue;
    }
    if (!openingTag) {
      continue;
    }
    const attributes = new Map([...(attributeText ?? "").matchAll(ATTRIBUTE_PATTERN)].map((match) => [match[1]!, decodeEntities(match[2] ?? "")]));
    const element = new FakeElement(document, openingTag.toUpperCase(), attributes);
    element.parent = stack[stack.length - 1]!;
    element.parent.children.push(element);
    if (!selfClosing && !VOID_TAGS.has(openingTag.toLowerCase())) {
      stack.push(element);
    }
  }
  document.body = document.querySelector("body")!;
  return document;
}

// ---------------------------------------------------------- client harness

interface PostedMessage {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** Plays the iframe host: `vscode.getState` survives document replacement like VS Code's webview state. */
class FakeWebview {
  readonly posted: PostedMessage[] = [];
  state: unknown = undefined;
  document!: FakeDocument;
  window!: FakeEventTarget;

  load(html: string): this {
    this.document = parseDocument(html);
    this.window = new FakeEventTarget();
    this.run();
    return this;
  }

  /** Evaluates the client in the current document, as one iframe instance would. */
  run(): void {
    let isApiAcquired = false;
    const acquireVsCodeApi = (): unknown => {
      if (isApiAcquired) {
        throw new Error("acquireVsCodeApi called twice");
      }
      isApiAcquired = true;
      return {
        postMessage: (message: PostedMessage) => this.posted.push(message),
        getState: () => this.state,
        setState: (state: unknown) => {
          this.state = state;
        },
      };
    };
    vm.runInNewContext(CLIENT_SOURCE, {
      acquireVsCodeApi,
      document: this.document,
      window: this.window,
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, FRAME_MS),
    });
  }

  element(id: string): FakeElement {
    const element = this.document.getElementById(id);
    if (!element) {
      throw new Error(`no #${id}`);
    }
    return element;
  }

  row(oid: string): FakeElement {
    return this.find("tr.commit-row", (element) => element.dataset.oid === oid);
  }

  find(selector: string, predicate: (element: FakeElement) => boolean): FakeElement {
    const element = this.document.querySelectorAll(selector).find(predicate);
    if (!element) {
      throw new Error(`no ${selector} match`);
    }
    return element;
  }

  /** Focuses like a mouse press, then dispatches from the innermost child, as for a click on cell text. */
  click(target: FakeElement, init: EventInit = {}): void {
    if (FOCUSABLE_TAGS.has(target.tagName)) {
      target.focus();
    }
    const inner = target.descendants()[0] ?? target;
    inner.dispatch(new FakeEvent("click", inner, init));
  }

  key(target: FakeElement, key: string, init: EventInit = {}): FakeEvent {
    const event = new FakeEvent("keydown", target, { ...init, key });
    target.dispatch(event);
    return event;
  }

  /** Replaces the text, leaving the caret at its end as typing does. */
  type(input: FakeElement, text: string): void {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatch(new FakeEvent("input", input));
  }

  change(select: FakeElement, value: string): void {
    select.value = value;
    select.dispatch(new FakeEvent("change", select));
  }

  /** The most recent message. */
  last(): PostedMessage | undefined {
    return this.posted[this.posted.length - 1];
  }

  intents(): readonly PostedMessage[] {
    return this.posted.filter((message) => message.type !== "ready");
  }
}

// ------------------------------------------------------------------ fixture

const NONCE = "abcdefghijklmnopqrstuvwxyz012345";
const SNAPSHOT_ID = "6f1c2a7e-1111-4222-8333-944455556666";
const FILE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const OTHER_FILE_ID = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const REPOSITORY_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_REPOSITORY_ID = "99999999-2222-4333-8444-555555555555";

function oid(index: number): string {
  return index.toString(16).padStart(40, "0");
}

const [A, B, C, D, E] = [5, 4, 3, 2, 1].map(oid) as [string, string, string, string, string];

function commit(id: string, subject: string, parents: readonly string[]): HistoryCommit {
  return { oid: id, parents, author: "Ada", authoredDate: "2026-03-04T05:06:07+02:00", subject };
}

const history: HistoryData = {
  commits: [
    commit(A, "Merge", [B, C]),
    commit(B, "Bravo", [D]),
    commit(C, "Charlie", [D]),
    commit(D, "Delta", [E]),
    commit(E, "Echo", []),
  ],
  refs: [{ kind: "localBranch", name: "main", oid: A }],
};

const files: readonly ComparisonFile[] = [
  { id: FILE_ID, status: "modified", base: { path: "a.txt", blob: oid(10), mode: "100644" }, result: { path: "a.txt", blob: oid(11), mode: "100644" }, contentKind: "text" },
  { id: OTHER_FILE_ID, status: "added", base: null, result: { path: "b.txt", blob: oid(12), mode: "100644" }, contentKind: "text" },
];

interface Publication {
  readonly selectedOids?: readonly string[];
  readonly visibleOids?: readonly string[];
  readonly focusedOid?: string | null;
  readonly search?: string;
  readonly rowLimit?: number;
  readonly revision?: number;
  readonly repositoryId?: string;
}

function publish(publication: Publication = {}): string {
  const selectedOids = publication.selectedOids ?? [];
  const state: HistoryState = {
    revision: 1,
    history,
    selectedOids,
    base: { kind: "automatic" },
    mainlines: [],
    comparison: selectedOids.length === 0
      ? null
      : { kind: "ready", snapshotId: SNAPSHOT_ID, base: { kind: "emptyTree" }, orderedOids: selectedOids, files },
    operations: { isLoading: false, isResolvingBase: false, isComparing: false },
    error: null,
  };
  const repositoryId = publication.repositoryId ?? REPOSITORY_ID;
  const context: HistoryRenderContext = {
    assets: { styleUri: "res://history.css", scriptUri: "res://history.js", cspSource: "res:" },
    nonce: NONCE,
    repositories: [{ id: REPOSITORY_ID, name: "differ" }, { id: OTHER_REPOSITORY_ID, name: "other" }],
    activeRepositoryId: repositoryId,
    presentation: {
      search: publication.search ?? "",
      branchOid: null,
      focusedOid: publication.focusedOid ?? null,
      rowLimit: publication.rowLimit ?? HISTORY_PAGE_SIZE,
    },
    visibleOids: publication.visibleOids ?? history.commits.map((entry) => entry.oid),
    hiddenSelectedCount: 0,
    wireRevision: publication.revision ?? 7,
  };
  return new HtmlHistoryRenderer().render(state, context);
}

function open(publication: Publication = {}): FakeWebview {
  return new FakeWebview().load(publish(publication));
}

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
      branchOid: null,
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
      { type: "presentation", revision: 8, search: "", branchOid: null, focusedOid: C, rowLimit: HISTORY_PAGE_SIZE },
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

    expect(webview.intents()).toEqual([
      { type: "refresh", revision: 7 },
      { type: "chooseRepository", revision: 7 },
      { type: "repository", revision: 7, repositoryId: OTHER_REPOSITORY_ID },
      { type: "base", revision: 7, ref: null },
      { type: "base", revision: 7, ref: "v1.0" },
      { type: "mainline", revision: 7, oid: A, parentNumber: 2 },
      { type: "select", revision: 7, oids: [], focusedOid: null },
    ]);
  });

  it("ignores an empty base ref", () => {
    const webview = open();

    webview.click(webview.element("history-base-pin"));

    expect(webview.intents()).toEqual([]);
  });

  it("changes only presentation for branch filters and Load more", () => {
    const many: HistoryData = { commits: Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, index) => commit(oid(100 + index), `c${index}`, [])), refs: history.refs };
    const html = new HtmlHistoryRenderer().render(
      { revision: 1, history: many, selectedOids: [], base: { kind: "automatic" }, mainlines: [], comparison: null, operations: { isLoading: false, isResolvingBase: false, isComparing: false }, error: null },
      {
        assets: { styleUri: "s", scriptUri: "j", cspSource: "res:" },
        nonce: NONCE,
        repositories: [],
        activeRepositoryId: null,
        presentation: { search: "", branchOid: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE },
        visibleOids: many.commits.map((entry) => entry.oid),
        hiddenSelectedCount: 0,
        wireRevision: 3,
      },
    );
    const webview = new FakeWebview().load(html);

    webview.click(webview.element("history-load-more"));
    webview.change(webview.element("history-branch"), A);

    expect(webview.intents()).toEqual([
      { type: "presentation", revision: 3, search: "", branchOid: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE * 2 },
      { type: "presentation", revision: 3, search: "", branchOid: A, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE },
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
      { type: "presentation", revision: 7, search: "fix", branchOid: null, focusedOid: null, rowLimit: HISTORY_PAGE_SIZE },
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
      branchOid: null,
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
});
