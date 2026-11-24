import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { HISTORY_PAGE_SIZE, HtmlHistoryRenderer } from "../render/html/historyRenderer";
import type { HistoryPage, HistoryPresentation, HistoryRenderContext, HistoryUpdate } from "../render/html/historyRenderer";
import type { ComparisonFile, HistoryCommit, HistoryData, HistoryState } from "../model/historyTypes";

// A minimal DOM for running the history page's scripts in a VM context, the page as the renderer publishes it, and a
// host sending it updates. Shared by the history client's tests and its branch filter's.

const MEDIA = path.join(__dirname, "..", "..", "media");
/** The scripts the page loads, in its order; they share one global scope. */
const CLIENT_SOURCE = ["fuzzyMatch.js", "branchFilter.js", "history.js"].map((file) => fs.readFileSync(path.join(MEDIA, file), "utf8")).join("\n");

// ------------------------------------------------- minimal DOM fixture

const FOCUSABLE_TAGS = new Set(["TR", "BUTTON", "INPUT", "SELECT"]);
const VOID_TAGS = new Set(["meta", "link", "input", "br", "img", "hr"]);
const TOKEN_PATTERN = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:="[^"]*")?)*)\s*(\/?)>/g;
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g;
const SELECTOR_PATTERN = /^([a-z0-9]*)((?:\.[-\w]+)*)$/;
export const FRAME_MS = 16;
export const FOCUS_DEBOUNCE_MS = 250;

type Listener = (event: FakeEvent) => void;

interface EventInit {
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly isComposing?: boolean;
  readonly inputType?: string;
  readonly data?: unknown;
}

export class FakeEvent {
  defaultPrevented = false;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly inputType: string;
  readonly data: unknown;

  constructor(readonly type: string, readonly target: FakeElement, init: EventInit = {}) {
    this.key = init.key ?? "";
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.altKey = init.altKey ?? false;
    this.isComposing = init.isComposing ?? false;
    this.inputType = init.inputType ?? "";
    this.data = init.data;
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

/** Text between tags, or a string a client appended. */
class FakeText {
  parent: FakeElement | null = null;

  constructor(readonly textContent: string) {}
}

type FakeNode = FakeElement | FakeText;

/** A laid-out box: every element is 100 × 20 at the panel's top left. */
const FAKE_RECT = { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };

export class FakeElement extends FakeEventTarget {
  readonly childNodes: FakeNode[] = [];
  parent: FakeElement | null = null;
  scrollTop = 0;
  readonly clientHeight = 0;
  readonly scrollHeight = 0;
  readonly offsetWidth = 0;
  /** `scrollIntoView` calls, as their options. */
  readonly scrolledIntoView: unknown[] = [];
  /** `getBoundingClientRect` calls, each a layout read in a browser. */
  boundingRectReads = 0;
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

  set id(id: string) {
    this.attributes.set("id", id);
  }

  set className(className: string) {
    this.attributes.set("class", className);
  }

  get placeholder(): string {
    return this.attributes.get("placeholder") ?? "";
  }

  set placeholder(placeholder: string) {
    this.attributes.set("placeholder", placeholder);
  }

  get title(): string {
    return this.attributes.get("title") ?? "";
  }

  set title(title: string) {
    this.attributes.set("title", title);
  }

  get hidden(): boolean {
    return this.attributes.has("hidden");
  }

  set hidden(isHidden: boolean) {
    if (isHidden) {
      this.attributes.set("hidden", "");
    } else {
      this.attributes.delete("hidden");
    }
  }

  /** `data-*` attributes by camel-cased name, readable and writable. */
  get dataset(): Record<string, string> {
    const attributeName = (key: string): string => `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_target, key) => (typeof key === "string" ? this.attributes.get(attributeName(key)) : undefined),
      set: (_target, key, value: string) => {
        this.attributes.set(attributeName(String(key)), String(value));
        return true;
      },
    });
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  set textContent(text: string) {
    this.replaceChildren(text);
  }

  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeText(node) : node;
      child.parent = this;
      this.childNodes.push(child);
    }
  }

  replaceChildren(...nodes: (FakeNode | string)[]): void {
    for (const node of this.childNodes) {
      node.parent = null;
    }
    this.childNodes.length = 0;
    this.append(...nodes);
  }

  getBoundingClientRect(): typeof FAKE_RECT {
    this.boundingRectReads++;
    return FAKE_RECT;
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

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  get isConnected(): boolean {
    let element: FakeElement = this;
    while (element.parent) {
      element = element.parent;
    }
    return element.tagName === "#document";
  }

  /** Replaces this element with the parsed markup, as assigning `outerHTML` does. */
  set outerHTML(markup: string) {
    const parent = this.parent!;
    const index = parent.childNodes.indexOf(this);
    const replacements = parseInto(new FakeElement(this.owner, "#fragment", new Map()), markup).childNodes;
    replacements.forEach((node) => {
      node.parent = parent;
    });
    parent.childNodes.splice(index, 1, ...replacements);
    this.parent = null;
  }

  insertAdjacentHTML(position: string, markup: string): void {
    if (position !== "beforeend") {
      throw new Error(`Unsupported position in fixture: ${position}`);
    }
    this.append(...parseInto(new FakeElement(this.owner, "#fragment", new Map()), markup).childNodes);
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

  /** Takes the focus from the focused element, which hears `blur`. */
  focus(): void {
    const previous = this.owner!.activeElement;
    if (previous === this) {
      return;
    }
    this.owner!.activeElement = this;
    previous?.notify(new FakeEvent("blur", previous));
    this.dispatch(new FakeEvent("focusin", this));
  }

  blur(): void {
    if (this.owner!.activeElement === this) {
      this.owner!.activeElement = null;
      this.notify(new FakeEvent("blur", this));
    }
  }

  scrollIntoView(options: unknown): void {
    this.scrolledIntoView.push(options);
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

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName.toUpperCase(), new Map());
  }
}

/** A panel 800 × 600 for the branch list to be placed in. */
class FakeWindow extends FakeEventTarget {
  readonly innerWidth = 800;
  readonly innerHeight = 600;
}

function decodeEntities(text: string): string {
  return text.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Parses the renderer's well-formed output: elements, double-quoted attributes and text. */
function parseDocument(html: string): FakeDocument {
  const document = parseInto(new FakeDocument(), html);
  document.body = document.querySelector("body")!;
  return document;
}

/** Appends the elements of `html` to `root`, owned by `root`'s document. */
function parseInto<T extends FakeElement>(root: T, html: string): T {
  const document = root instanceof FakeDocument ? root : root.owner!;
  const stack: FakeElement[] = [root];
  let textStart = 0;
  for (const token of html.matchAll(TOKEN_PATTERN)) {
    const [, closingTag, openingTag, attributeText, selfClosing] = token;
    if (token.index > textStart) {
      stack[stack.length - 1]!.append(decodeEntities(html.slice(textStart, token.index)));
    }
    textStart = token.index + token[0].length;
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
    stack[stack.length - 1]!.append(element);
    if (!selfClosing && !VOID_TAGS.has(openingTag.toLowerCase())) {
      stack.push(element);
    }
  }
  return root;
}

// ---------------------------------------------------------- client harness

interface PostedMessage {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** Plays the iframe host: `vscode.getState` survives document replacement like VS Code's webview state. */
export class FakeWebview {
  readonly posted: PostedMessage[] = [];
  state: unknown = undefined;
  document!: FakeDocument;
  window!: FakeWindow;
  /** The client's global scope, so a test can wrap what one script exposes to the others. */
  globals!: Record<string, unknown>;

  load(html: string): this {
    this.document = parseDocument(html);
    this.window = new FakeWindow();
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
    this.globals = {
      acquireVsCodeApi,
      document: this.document,
      window: this.window,
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, FRAME_MS),
    };
    vm.runInNewContext(CLIENT_SOURCE, this.globals);
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

  /** Replaces the text, leaving the caret at its end as typing does; `text` is the inserted data. */
  type(input: FakeElement, text: string): void {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatch(new FakeEvent("input", input, { inputType: "insertText", data: text }));
  }

  change(select: FakeElement, value: string): void {
    select.value = value;
    select.dispatch(new FakeEvent("change", select));
  }

  /** Delivers a host message, as `webview.postMessage` does. */
  receive(data: unknown): void {
    this.window.notify(new FakeEvent("message", this.document, { data }));
  }

  /** Presses the mouse button on `target`, before any focus change or click; returns the event. */
  press(target: FakeElement): FakeEvent {
    const event = new FakeEvent("mousedown", target);
    target.dispatch(event);
    return event;
  }

  /** The branch list's entries as their text, the marked letters in brackets. */
  branchOptions(): string[] {
    return this.element("history-branch-list").querySelectorAll("li").map(marked);
  }

  /** The option `aria-activedescendant` names, as `branchOptions` shows it. */
  activeBranch(): string | null {
    const id = this.element("history-branch-input").getAttribute("aria-activedescendant");
    return id === null ? null : marked(this.element(id));
  }

  /** Opens the branch list with a click, types `query` and picks the first match with Enter. */
  pickBranch(query: string): void {
    const input = this.element("history-branch-input");
    this.click(input);
    this.type(input, query);
    this.key(input, "Enter");
  }

  /** The most recent message. */
  last(): PostedMessage | undefined {
    return this.posted[this.posted.length - 1];
  }

  intents(): readonly PostedMessage[] {
    return this.posted.filter((message) => message.type !== "ready");
  }
}

export function marked(element: FakeElement): string {
  return element.childNodes.map((node) => (node instanceof FakeElement ? `[${node.textContent}]` : node.textContent)).join("");
}

// ------------------------------------------------------------------ fixture

export const NONCE = "abcdefghijklmnopqrstuvwxyz012345";
export const SNAPSHOT_ID = "6f1c2a7e-1111-4222-8333-944455556666";
export const FILE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
export const OTHER_FILE_ID = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const REPOSITORY_ID = "11111111-2222-4333-8444-555555555555";
export const OTHER_REPOSITORY_ID = "99999999-2222-4333-8444-555555555555";

export function oid(index: number): string {
  return index.toString(16).padStart(40, "0");
}

export const [A, B, C, D, E] = [5, 4, 3, 2, 1].map(oid) as [string, string, string, string, string];

/** Branches of several kinds and shapes, all at loaded commits. */
export const BRANCHES: HistoryData["refs"] = [
  { kind: "localBranch", name: "main", oid: A },
  { kind: "localBranch", name: "feature/branch-filter", oid: B },
  { kind: "localBranch", name: "fix/bug", oid: C },
  { kind: "remoteBranch", name: "origin/main", oid: A },
];

export function commit(id: string, subject: string, parents: readonly string[]): HistoryCommit {
  return { oid: id, parents, author: "Ada", authoredDate: "2026-03-04T05:06:07+02:00", subject };
}

export const history: HistoryData = {
  commits: [
    commit(A, "Merge", [B, C]),
    commit(B, "Bravo", [D]),
    commit(C, "Charlie", [D]),
    commit(D, "Delta", [E]),
    commit(E, "Echo", []),
  ],
  refs: [{ kind: "localBranch", name: "main", oid: A }],
  head: null,
  isTruncated: false,
};

const files: readonly ComparisonFile[] = [
  { id: FILE_ID, status: "modified", base: { path: "a.txt", blob: oid(10), mode: "100644" }, result: { path: "a.txt", blob: oid(11), mode: "100644" }, contentKind: "text" },
  { id: OTHER_FILE_ID, status: "added", base: null, result: { path: "b.txt", blob: oid(12), mode: "100644" }, contentKind: "text" },
];

/** One array for every publication, as the host's cache returns for unchanged filters. */
const ALL_OIDS = history.commits.map((entry) => entry.oid);

interface Publication {
  readonly selectedOids?: readonly string[];
  readonly visibleOids?: readonly string[];
  readonly focusedOid?: string | null;
  readonly search?: string;
  readonly rowLimit?: number;
  readonly branch?: HistoryPresentation["branch"];
  /** The published branch choice; the branch filter's ref by default. */
  readonly branchChoice?: string;
  readonly revision?: number;
  readonly repositoryId?: string;
  /** File of the listed snapshot the diff panel shows. */
  readonly openFileId?: string | null;
  /** The history's refs, in place of `history`'s one branch. */
  readonly refs?: HistoryData["refs"];
}

export function publish(publication: Publication = {}): string {
  const { state, context } = pageFor(publication);
  return new HtmlHistoryRenderer().render(state, context).html;
}

function pageFor(publication: Publication): { readonly state: HistoryState; readonly context: HistoryRenderContext } {
  const selectedOids = publication.selectedOids ?? [];
  const state: HistoryState = {
    revision: 1,
    history: publication.refs ? { ...history, refs: publication.refs } : history,
    workingChanges: null,
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
    fuzzyMatchScriptUri: "res://fuzzyMatch.js",
    branchFilterScriptUri: "res://branchFilter.js",
    nonce: NONCE,
    repositories: [{ id: REPOSITORY_ID, name: "differ" }, { id: OTHER_REPOSITORY_ID, name: "other" }],
    activeRepositoryId: repositoryId,
    presentation: {
      search: publication.search ?? "",
      branchChoice: publication.branchChoice ?? publication.branch?.ref ?? null,
      branch: publication.branch ?? null,
      focusedOid: publication.focusedOid ?? null,
      rowLimit: publication.rowLimit ?? HISTORY_PAGE_SIZE,
    },
    visibleOids: publication.visibleOids ?? ALL_OIDS,
    hiddenSelectedCount: 0,
    wireRevision: publication.revision ?? 7,
    openedFile: publication.openFileId ? { snapshotId: SNAPSHOT_ID, fileId: publication.openFileId } : null,
  };
  return { state, context };
}

/** Plays the provider: loads one document, then sends updates against what it shows. */
export class FakeHost {
  private readonly renderer = new HtmlHistoryRenderer();
  private page: HistoryPage | null = null;

  open(publication: Publication = {}): FakeWebview {
    const { state, context } = pageFor(publication);
    const document = this.renderer.render(state, context);
    this.page = document.page;
    return new FakeWebview().load(document.html);
  }

  update(publication: Publication): HistoryUpdate {
    const { state, context } = pageFor(publication);
    const patch = this.renderer.update(state, context, this.page!);
    this.page = patch.page;
    return patch.update;
  }
}

export function open(publication: Publication = {}): FakeWebview {
  return new FakeWebview().load(publish(publication));
}
