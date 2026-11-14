import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

// A minimal DOM for running the merge page's scripts in a VM context: only what `merge.js` touches on load and
// while editing the result, from the renderer's well-formed output. Offsets inside ranges count characters of
// the page's text, as a browser's do; connectors are never drawn, as nothing here depends on them.

const MEDIA_ROOT = path.join(__dirname, "..", "..", "media");
/** The scripts the merge page loads, in its order; they share one global scope. */
const CLIENT_SOURCES = ["diffGeometry.js", "mergeLines.js", "merge.js"].map((name) => fs.readFileSync(path.join(MEDIA_ROOT, name), "utf8"));

const VOID_TAGS = new Set(["meta", "link", "input", "br", "img", "hr"]);
const TOKEN_PATTERN = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:="[^"]*")?)*)\s*(\/?)>/g;
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g;
/** `tag.class.class[attribute]`, each part optional. */
const SELECTOR_PATTERN = /^([a-z0-9]*)((?:\.[-\w]+)*)(?:\[([-\w]+)\])?$/;
const LINE_HEIGHT = 18;
const SHOW_TEXT = 4;

type Listener = (event: FakeEvent) => void;

/** An event carrying whatever fields the test gives it (`key`, `keyCode`, `inputType`, `data`, …). */
class FakeEvent {
  [field: string]: unknown;
  defaultPrevented = false;
  isPropagationStopped = false;

  constructor(readonly type: string, readonly target: FakeEventTarget, init: Readonly<Record<string, unknown>> = {}) {
    Object.assign(this, init);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.isPropagationStopped = true;
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

abstract class FakeNode extends FakeEventTarget {
  parent: FakeElement | null = null;

  abstract get textContent(): string;

  get parentElement(): FakeElement | null {
    return this.parent;
  }

  remove(): void {
    if (this.parent) {
      this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1);
      this.parent = null;
    }
  }

  /** Bubbles from this node up to the document. */
  dispatch(event: FakeEvent): void {
    for (let node: FakeNode | null = this; node && !event.isPropagationStopped; node = node.parent) {
      node.notify(event);
    }
  }
}

export class FakeText extends FakeNode {
  constructor(public data: string) {
    super();
  }

  get textContent(): string {
    return this.data;
  }
}

export class FakeElement extends FakeNode {
  readonly childNodes: FakeNode[] = [];
  scrollTop = 0;
  clientHeight = 0;
  scrollHeight = 0;
  inert = false;
  tabIndex = 0;

  constructor(readonly owner: FakeDocument | null, readonly tagName: string, readonly attributes: Map<string, string>) {
    super();
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }

  set className(name: string) {
    this.attributes.set("class", name);
  }

  get classList(): string[] & { contains(name: string): boolean } {
    const names = this.className.split(/\s+/).filter(Boolean);
    return Object.assign(names, { contains: (name: string) => names.includes(name) });
  }

  /** Reads and writes `data-*` attributes, as the DOM's live `dataset` does. */
  get dataset(): Record<string, string | undefined> {
    const attributeOf = (key: string): string => `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_target, key) => (typeof key === "string" ? this.attributes.get(attributeOf(key)) : undefined),
      set: (_target, key, value) => {
        this.attributes.set(attributeOf(String(key)), String(value));
        return true;
      },
    });
  }

  get disabled(): boolean {
    return this.attributes.has("disabled");
  }

  set disabled(isDisabled: boolean) {
    if (isDisabled) {
      this.attributes.set("disabled", "");
    } else {
      this.attributes.delete("disabled");
    }
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(text: string) {
    [...this.childNodes].forEach((child) => child.remove());
    this.append(new FakeText(text));
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      this.insertBefore(typeof node === "string" ? new FakeText(node) : node, null);
    }
  }

  insertBefore(node: FakeNode, reference: FakeNode | null): void {
    node.remove();
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    this.childNodes.splice(index, 0, node);
    node.parent = this;
  }

  after(...nodes: FakeNode[]): void {
    const parent = this.parent!;
    const next = parent.childNodes[parent.childNodes.indexOf(this) + 1] ?? null;
    nodes.forEach((node) => parent.insertBefore(node, next));
  }

  contains(node: FakeNode): boolean {
    for (let current: FakeNode | null = node; current; current = current.parent) {
      if (current === this) {
        return true;
      }
    }
    return false;
  }

  matches(selector: string): boolean {
    const match = SELECTOR_PATTERN.exec(selector);
    if (!match) {
      throw new Error(`Unsupported selector in fixture: ${selector}`);
    }
    const [, tag, classPart, attribute] = match;
    const isTagMatch = tag === "" || this.tagName === tag!.toUpperCase();
    const isClassMatch = classPart!.split(".").filter(Boolean).every((name) => this.classList.contains(name));
    return isTagMatch && isClassMatch && (attribute === undefined || this.attributes.has(attribute));
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
    const children = this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
    return children.flatMap((child) => [child, ...child.descendants()]);
  }

  focus(): void {
    this.owner!.activeElement = this;
  }

  blur(): void {
    this.owner!.activeElement = null;
  }

  getBoundingClientRect(): { readonly height: number } {
    return { height: LINE_HEIGHT };
  }

  scrollIntoView(): void {}
}

/** A DOM change the page's `MutationObserver` reports. */
interface FakeMutationRecord {
  readonly type: "characterData" | "childList";
  readonly target: FakeNode;
  readonly oldValue: string | null;
  readonly addedNodes: readonly FakeNode[];
  readonly removedNodes: readonly FakeNode[];
  readonly nextSibling: FakeNode | null;
}

class FakeDocument extends FakeElement {
  activeElement: FakeElement | null = null;
  /** Changes the browser made that the page's observer has not taken yet. */
  readonly mutations: FakeMutationRecord[] = [];

  constructor() {
    super(null, "#document", new Map());
  }

  get body(): FakeElement {
    return this.querySelector("body")!;
  }

  get title(): string {
    return this.querySelector("title")?.textContent ?? "";
  }

  getElementById(id: string): FakeElement | null {
    return this.descendants().find((element) => element.id === id) ?? null;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName.toUpperCase(), new Map());
  }

  createRange(): FakeRange {
    return new FakeRange();
  }

  createTreeWalker(root: FakeElement): FakeTextWalker {
    return new FakeTextWalker(root);
  }

  /** The browser's editing commands change nothing here; tests play their effects as events. */
  execCommand(): boolean {
    return true;
  }
}

/**
 * Characters of text before the point `offset` into `node`, counted from the root of its tree. Points with no text
 * between them count as one, such as the end of one cell and the start of the next.
 */
function textOffsetOf(node: FakeNode, offset: number): number {
  let root = node;
  while (root.parent) {
    root = root.parent;
  }
  let before = 0;
  const visit = (current: FakeNode): boolean => {
    if (current === node) {
      return true;
    }
    if (current instanceof FakeText) {
      before += current.data.length;
      return false;
    }
    return (current as FakeElement).childNodes.some(visit);
  };
  visit(root);
  const inside = node instanceof FakeElement ? node.childNodes.slice(0, offset).map((child) => child.textContent).join("") : node.textContent.slice(0, offset);
  return before + inside.length;
}

class FakeRange {
  startContainer: FakeNode | null = null;
  startOffset = 0;
  endContainer: FakeNode | null = null;
  endOffset = 0;

  selectNodeContents(node: FakeNode): void {
    this.setStart(node, 0);
    this.setEnd(node, node instanceof FakeElement ? node.childNodes.length : node.textContent.length);
  }

  setStart(node: FakeNode, offset: number): void {
    this.startContainer = node;
    this.startOffset = offset;
  }

  setEnd(node: FakeNode, offset: number): void {
    this.endContainer = node;
    this.endOffset = offset;
  }

  collapse(toStart: boolean): void {
    if (toStart) {
      this.setEnd(this.startContainer!, this.startOffset);
    } else {
      this.setStart(this.endContainer!, this.endOffset);
    }
  }

  get isCollapsed(): boolean {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  comparePoint(node: FakeNode, offset: number): number {
    const point = textOffsetOf(node, offset);
    if (point < textOffsetOf(this.startContainer!, this.startOffset)) {
      return -1;
    }
    return point > textOffsetOf(this.endContainer!, this.endOffset) ? 1 : 0;
  }

  toString(): string {
    let root = this.startContainer!;
    while (root.parent) {
      root = root.parent;
    }
    return root.textContent.slice(textOffsetOf(this.startContainer!, this.startOffset), textOffsetOf(this.endContainer!, this.endOffset));
  }
}

class FakeSelection {
  private range: FakeRange | null = null;

  get rangeCount(): number {
    return this.range ? 1 : 0;
  }

  get isCollapsed(): boolean {
    return !this.range || this.range.isCollapsed;
  }

  getRangeAt(): FakeRange {
    return this.range!;
  }

  addRange(range: FakeRange): void {
    this.range = range;
  }

  removeAllRanges(): void {
    this.range = null;
  }

  selectAllChildren(node: FakeElement): void {
    this.range = new FakeRange();
    this.range.selectNodeContents(node);
  }

  collapseToEnd(): void {
    this.range?.collapse(false);
  }
}

/** Walks the text nodes under a root, as a `TreeWalker` showing text does. */
class FakeTextWalker {
  currentNode: FakeNode;
  private readonly nodes: FakeText[];
  private index = -1;

  constructor(root: FakeElement) {
    const textsOf = (node: FakeNode): FakeText[] => (node instanceof FakeText ? [node] : (node as FakeElement).childNodes.flatMap(textsOf));
    this.nodes = textsOf(root);
    this.currentNode = root;
  }

  nextNode(): FakeNode | null {
    const next = this.nodes[this.index + 1];
    if (!next) {
      return null;
    }
    this.index += 1;
    this.currentNode = next;
    return next;
  }
}

class FakeWindow extends FakeEventTarget {
  readonly selection = new FakeSelection();

  getSelection(): FakeSelection {
    return this.selection;
  }

  /** Global timers, so Vitest's fake timers drive the page's debounce. */
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delay);
  }

  clearTimeout(handle: ReturnType<typeof setTimeout> | undefined): void {
    clearTimeout(handle);
  }
}

/** Hands the page the changes the browser made in the current task; the page's own changes are not recorded. */
class FakeMutationObserver {
  private observed: FakeElement | null = null;

  observe(target: FakeElement): void {
    this.observed = target;
  }

  takeRecords(): FakeMutationRecord[] {
    return this.observed ? this.observed.owner!.mutations.splice(0) : [];
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Parses the renderer's well-formed output: elements, double-quoted attributes and text. */
function parseDocument(html: string): FakeDocument {
  const document = new FakeDocument();
  const stack: FakeElement[] = [document];
  let textStart = 0;
  for (const token of html.matchAll(TOKEN_PATTERN)) {
    const parent = stack[stack.length - 1]!;
    const text = html.slice(textStart, token.index);
    textStart = token.index! + token[0].length;
    if (text !== "") {
      parent.append(new FakeText(decodeEntities(text)));
    }
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
    parent.append(element);
    if (!selfClosing && !VOID_TAGS.has(openingTag.toLowerCase())) {
      stack.push(element);
    }
  }
  return document;
}

export interface PostedMessage {
  readonly type: string;
  readonly [field: string]: unknown;
}

/**
 * One merge page in its webview: runs the page's scripts over the rendered HTML, records what the page posts,
 * and plays the user and the browser. User input never reaches an inert subtree, as in a browser.
 */
export class MergePage {
  readonly posted: PostedMessage[] = [];
  readonly document: FakeDocument;
  readonly window = new FakeWindow();
  /** Called as each message is posted, to see the page at that moment. */
  onPost: (message: PostedMessage) => void = () => undefined;

  constructor(html: string) {
    this.document = parseDocument(html);
    const context = vm.createContext({
      acquireVsCodeApi: () => ({
        postMessage: (message: PostedMessage) => {
          this.posted.push(JSON.parse(JSON.stringify(message)) as PostedMessage);
          this.onPost(message);
        },
        getState: () => undefined,
        setState: () => undefined,
      }),
      document: this.document,
      window: this.window,
      // Frames never come, so connectors are never drawn.
      requestAnimationFrame: () => 0,
      MutationObserver: FakeMutationObserver,
      Element: FakeElement,
      Text: FakeText,
      NodeFilter: { SHOW_TEXT },
    });
    CLIENT_SOURCES.forEach((source) => vm.runInContext(source, context));
  }

  resultCell(line: number): FakeElement {
    return this.find(".code[data-line]", (cell) => cell.dataset.line === String(line));
  }

  button(predicate: (button: FakeElement) => boolean): FakeElement {
    return this.find("button", predicate);
  }

  /** The hidden editable that gives the browser's own undo and redo a step to take. */
  historySeed(): FakeElement {
    return this.find(".history-seed", () => true);
  }

  /** Replaces a cell's text with `text`, leaving the caret at its end, as typing does. */
  type(cell: FakeElement, text: string): void {
    cell.textContent = text;
    this.placeCaret(cell, text.length);
    this.userEvent(cell, "input", { inputType: "insertText" });
  }

  placeCaret(cell: FakeElement, offset: number): void {
    const range = new FakeRange();
    range.setStart(cell.childNodes[0]!, offset);
    range.collapse(true);
    this.window.selection.addRange(range);
  }

  /** Selects from `offset` into `start` to `endOffset` into `end`, as a drag does. */
  select(start: FakeNode, offset: number, end: FakeNode, endOffset: number): void {
    const range = new FakeRange();
    range.setStart(start, offset);
    range.setEnd(end, endOffset);
    this.window.selection.addRange(range);
  }

  /** Copies the selection; the text the page put on the clipboard, or null when it left the copy to the browser. */
  copy(target: FakeElement): string | null {
    let copied: string | null = null;
    this.userEvent(target, "copy", { clipboardData: { setData: (_type: string, text: string) => (copied = text) } });
    return copied;
  }

  key(target: FakeElement, init: Readonly<Record<string, unknown>>): void {
    this.userEvent(target, "keydown", init);
  }

  input(target: FakeElement, inputType: string): void {
    this.userEvent(target, "input", { inputType });
  }

  beforeInput(target: FakeElement, inputType: string): void {
    this.userEvent(target, "beforeinput", { inputType });
  }

  paste(target: FakeElement, text: string): void {
    this.userEvent(target, "paste", { clipboardData: { getData: () => text } });
  }

  click(button: FakeElement): void {
    this.userEvent(button, "click");
  }

  /** A message from the host. */
  receive(message: Readonly<Record<string, unknown>>): void {
    this.window.notify(new FakeEvent("message", this.window, { data: message }));
    this.endTask();
  }

  /** The browser changes a text node, as its own undo does, and the page's observer notices. */
  browserChangesText(node: FakeText, data: string): void {
    this.document.mutations.push({ type: "characterData", target: node, oldValue: node.data, addedNodes: [], removedNodes: [], nextSibling: null });
    node.data = data;
  }

  /** The browser removes a node, as its own undo does, and the page's observer notices. */
  browserRemoves(node: FakeNode): void {
    const parent = node.parent!;
    const nextSibling = parent.childNodes[parent.childNodes.indexOf(node) + 1] ?? null;
    this.document.mutations.push({ type: "childList", target: parent, oldValue: null, addedNodes: [], removedNodes: [node], nextSibling });
    node.remove();
  }

  private userEvent(target: FakeElement, type: string, init: Readonly<Record<string, unknown>> = {}): void {
    if (!this.isInInertSubtree(target)) {
      target.dispatch(new FakeEvent(type, target, init));
    }
    this.endTask();
  }

  /** The page's observer callback drops the records a task leaves; only those of the current task can be taken. */
  private endTask(): void {
    this.document.mutations.length = 0;
  }

  private isInInertSubtree(target: FakeElement): boolean {
    for (let element: FakeElement | null = target; element; element = element.parent) {
      if (element.inert) {
        return true;
      }
    }
    return false;
  }

  private find(selector: string, predicate: (element: FakeElement) => boolean): FakeElement {
    const element = this.document.querySelectorAll(selector).find(predicate);
    if (!element) {
      throw new Error(`no ${selector} match`);
    }
    return element;
  }
}
