import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const MEDIA_ROOT = path.join(__dirname, "..", "..", "media");
const GEOMETRY_SOURCE = fs.readFileSync(path.join(MEDIA_ROOT, "diffGeometry.js"), "utf8");
/** The page loads the geometry first; both scripts share its global scope. */
const CLIENT_SOURCE = `${GEOMETRY_SOURCE}\n${fs.readFileSync(path.join(MEDIA_ROOT, "diff.js"), "utf8")}`;

interface Anchor {
  readonly base: number;
  readonly result: number;
}

interface ClientBlock {
  readonly kind: string;
  readonly base: readonly [number, number];
  readonly result: readonly [number, number];
}

type Side = "base" | "result";

interface Viewport {
  readonly top: number;
  readonly height: number;
  readonly max: number;
}

/** The pure geometry `diffGeometry.js` defines at top level. */
interface DiffGeometry {
  buildAnchors(blocks: readonly ClientBlock[], baseLineCount: number, resultLineCount: number): Anchor[];
  mapLine(anchors: readonly Anchor[], line: number, from: Side, to: Side): number;
  syncedScrollTop(
    anchors: readonly Anchor[],
    from: Side,
    to: Side,
    source: Viewport,
    target: Omit<Viewport, "top">,
    lineHeight: number,
  ): number;
  connectorPath(width: number, leftTop: number, leftBottom: number, rightTop: number, rightBottom: number): string;
  isBandVisible(top: number, bottom: number, height: number): boolean;
  neighbourBlock(blocks: readonly ClientBlock[], side: Side, line: number, direction: 1 | -1): number;
}

function loadGeometry(): DiffGeometry {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(GEOMETRY_SOURCE, context);
  return context as unknown as DiffGeometry;
}

// base:   0 1 [2 3 deleted] 4 5 [6→ added 6..9) 6 7 [8 modified →] ...
const BLOCKS: readonly ClientBlock[] = [
  { kind: "deleted", base: [2, 4], result: [2, 2] },
  { kind: "added", base: [6, 6], result: [4, 7] },
  { kind: "modified", base: [8, 9], result: [9, 12] },
];
const BASE_LINES = 12;
const RESULT_LINES = 15;

describe("diff client geometry", () => {
  const geometry = loadGeometry();
  const anchors = geometry.buildAnchors(BLOCKS, BASE_LINES, RESULT_LINES);

  it("anchors the start, both edges of every block, and the end", () => {
    expect(anchors).toEqual([
      { base: 0, result: 0 },
      { base: 2, result: 2 },
      { base: 4, result: 2 },
      { base: 6, result: 4 },
      { base: 6, result: 7 },
      { base: 8, result: 9 },
      { base: 9, result: 12 },
      { base: 12, result: 15 },
    ]);
  });

  it("maps unchanged lines one to one, shifted by the blocks above", () => {
    expect(geometry.mapLine(anchors, 1, "base", "result")).toBe(1);
    expect(geometry.mapLine(anchors, 5, "base", "result")).toBe(3);
    expect(geometry.mapLine(anchors, 10.5, "base", "result")).toBe(13.5);
    expect(geometry.mapLine(anchors, 13.5, "result", "base")).toBe(10.5);
  });

  it("maps inside a block proportionally between its edges", () => {
    expect(geometry.mapLine(anchors, 8.5, "base", "result")).toBe(10.5);
    expect(geometry.mapLine(anchors, 10.5, "result", "base")).toBe(8.5);
  });

  it("collapses a block onto the thin line of the side where it is empty", () => {
    expect(geometry.mapLine(anchors, 3, "base", "result")).toBe(2);
    expect(geometry.mapLine(anchors, 5.5, "result", "base")).toBe(6);
  });

  it("continues one to one past either end", () => {
    expect(geometry.mapLine(anchors, 14, "base", "result")).toBe(17);
    expect(geometry.mapLine(anchors, -1, "base", "result")).toBe(-1);
  });

  it("aligns the viewport centres and pins both ends", () => {
    const lineHeight = 20;
    const target = { height: 100, max: 200 };

    // Centre at base line 5 (100px) ↔ result line 3 (60px) → top 10.
    expect(geometry.syncedScrollTop(anchors, "base", "result", { top: 50, height: 100, max: 140 }, target, lineHeight))
      .toBe(10);
    expect(geometry.syncedScrollTop(anchors, "base", "result", { top: 0, height: 100, max: 140 }, target, lineHeight))
      .toBe(0);
    expect(geometry.syncedScrollTop(anchors, "base", "result", { top: 140, height: 100, max: 140 }, target, lineHeight))
      .toBe(200);
  });

  it("clamps a synced offset into the target's scroll range", () => {
    const top = geometry.syncedScrollTop(
      anchors,
      "result",
      "base",
      { top: 10, height: 100, max: 500 },
      { height: 100, max: 140 },
      20,
    );

    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(140);
  });

  it("draws a ribbon of two S-curves joining both block edges", () => {
    expect(geometry.connectorPath(40, 10, 50, 30, 30)).toBe(
      "M0,10 C20,10 20,30 40,30 L40,30 C20,30 20,50 0,50 Z",
    );
  });

  it("treats bands touching the strip as visible", () => {
    expect(geometry.isBandVisible(-20, 0, 100)).toBe(true);
    expect(geometry.isBandVisible(100, 120, 100)).toBe(true);
    expect(geometry.isBandVisible(-20, -1, 100)).toBe(false);
    expect(geometry.isBandVisible(101, 120, 100)).toBe(false);
  });

  it("finds the next and previous block relative to a line, skipping the one at it", () => {
    expect(geometry.neighbourBlock(BLOCKS, "result", 0, 1)).toBe(0);
    expect(geometry.neighbourBlock(BLOCKS, "result", 2, 1)).toBe(1);
    expect(geometry.neighbourBlock(BLOCKS, "result", 4, -1)).toBe(0);
    expect(geometry.neighbourBlock(BLOCKS, "result", 9, 1)).toBe(-1);
    expect(geometry.neighbourBlock(BLOCKS, "result", 2, -1)).toBe(-1);
  });
});

// ------------------------------------------------- webview wiring

interface FakeEventInit {
  readonly key?: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}

type Listener = (event: FakeEventInit & { preventDefault(): void; stopPropagation(): void }) => void;

/** What the listeners did with a fired event. */
interface FiredEvent {
  readonly isDefaultPrevented: boolean;
  /** Stopped before it bubbles up to the window, where VS Code's webview host forwards keys to the workbench. */
  readonly isPropagationStopped: boolean;
}

/** Scroll offsets clamp to the scrollable range, as in a browser. */
class FakeElement {
  private top = 0;
  scrollLeft = 0;
  clientHeight = 100;
  scrollHeight = 400;
  clientWidth = 40;
  disabled = false;
  hidden = false;
  textContent = "";
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  private readonly classes = new Set<string>();
  readonly classList = {
    contains: (name: string): boolean => this.classes.has(name),
    toggle: (name: string, force: boolean): void => {
      if (force) {
        this.classes.add(name);
      } else {
        this.classes.delete(name);
      }
    },
  };
  children: unknown[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  get scrollTop(): number {
    return this.top;
  }

  set scrollTop(value: number) {
    this.top = Math.min(Math.max(value, 0), this.scrollHeight - this.clientHeight);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: string, init: FakeEventInit = {}): FiredEvent {
    let isDefaultPrevented = false;
    let isPropagationStopped = false;
    for (const listener of this.listeners.get(type) ?? []) {
      listener({
        ...init,
        preventDefault: () => (isDefaultPrevented = true),
        stopPropagation: () => (isPropagationStopped = true),
      });
    }
    return { isDefaultPrevented, isPropagationStopped };
  }

  querySelector(): { getBoundingClientRect(): { height: number } } {
    return { getBoundingClientRect: () => ({ height: 20 }) };
  }

  replaceChildren(...children: unknown[]): void {
    this.children = children;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

interface Harness {
  readonly elements: Record<string, FakeElement>;
  readonly document: FakeElement;
  readonly messages: unknown[];
  /** What the script last saved with `setState`, as VS Code keeps it across re-renders. */
  savedState(): unknown;
  flushFrames(): void;
}

interface ClientStart {
  readonly title?: string;
  /** Webview state left by an earlier render of the same panel. */
  readonly state?: unknown;
  /** Published when the diff belongs to a list of changed files. */
  readonly files?: { readonly hasPrevious: boolean; readonly hasNext: boolean };
  readonly startAt?: "first" | "last";
}

function startClient(blocks: readonly ClientBlock[] = BLOCKS, start: ClientStart = {}): Harness {
  const ids = [
    "diff",
    "scroll-base",
    "scroll-result",
    "connectors",
    "prev",
    "next",
    "open-native",
    "file-step",
    "current-base",
    "current-result",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["current-base"].hidden = true;
  elements["current-result"].hidden = true;
  elements.diff.dataset.diff = JSON.stringify({ blocks, baseLineCount: BASE_LINES, resultLineCount: RESULT_LINES });
  if (start.files) {
    elements.diff.dataset.files = JSON.stringify(start.files);
  }
  if (start.startAt) {
    elements.diff.dataset.startAt = start.startAt;
  }
  const document = Object.assign(new FakeElement(), {
    title: start.title ?? "app.ts (a ↔ b)",
    getElementById: (id: string) => elements[id],
    createElementNS: () => new FakeElement(),
  });
  const messages: unknown[] = [];
  let frames: (() => void)[] = [];
  let state = start.state;

  vm.runInNewContext(CLIENT_SOURCE, {
    document,
    window: new FakeElement(),
    acquireVsCodeApi: () => ({
      postMessage: (message: unknown) => messages.push(message),
      getState: () => state,
      setState: (next: unknown) => (state = next),
    }),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    // Looked up on every call, so fake timers installed by a test apply.
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  });

  return {
    elements,
    document,
    messages,
    savedState: () => state,
    flushFrames: () => {
      const pending = frames;
      frames = [];
      pending.forEach((callback) => callback());
    },
  };
}

/** The rows `[start, end)` the current-change marker of `side` covers; null while it is hidden. */
function markedRows(elements: Record<string, FakeElement>, side: Side): [number, number] | null {
  const marker = elements[`current-${side}`];
  if (marker.hidden) {
    return null;
  }
  const rows = (value: string | undefined) => Number(/^calc\((\d+) \* var\(--row-height\)\)$/.exec(value ?? "")?.[1]);
  const start = rows(marker.style.top);
  return [start, start + rows(marker.style.height)];
}

describe("diff client wiring", () => {
  it("announces readiness once and asks for the native diff on request", () => {
    const { elements, messages } = startClient();

    elements["open-native"].fire("click");

    expect(messages).toEqual([{ type: "ready" }, { type: "openNative" }]);
  });

  it("starts at the first difference and steps with F7 and Shift+F7", () => {
    const { elements, document } = startClient();
    const result = elements["scroll-result"];

    // Navigation puts a block's first line a quarter of the viewport (25px) from the top.
    expect(result.scrollTop).toBe(2 * 20 - 25);

    document.fire("keydown", { key: "F7" });
    expect(result.scrollTop).toBe(4 * 20 - 25);

    document.fire("keydown", { key: "F7", shiftKey: true });
    expect(result.scrollTop).toBe(2 * 20 - 25);
  });

  it("steps onto blocks near the end that cannot scroll any further", () => {
    const nearEnd: ClientBlock[] = [
      { kind: "modified", base: [2, 3], result: [2, 3] },
      { kind: "modified", base: [17, 18], result: [17, 18] },
      { kind: "modified", base: [19, 20], result: [19, 20] },
    ];
    const { elements, document } = startClient(nearEnd);
    const result = elements["scroll-result"];

    document.fire("keydown", { key: "F7" });
    expect(result.scrollTop).toBe(300);
    expect(markedRows(elements, "result")).toEqual([17, 18]);

    document.fire("keydown", { key: "F7" });
    expect(result.scrollTop).toBe(300);
    expect(markedRows(elements, "result")).toEqual([19, 20]);

    document.fire("keydown", { key: "F7", shiftKey: true });
    document.fire("keydown", { key: "F7", shiftKey: true });
    expect(result.scrollTop).toBe(2 * 20 - 25);
    expect(markedRows(elements, "result")).toEqual([2, 3]);
  });

  it("starts at the top when the first difference is near it", () => {
    const { elements } = startClient([{ kind: "added", base: [0, 0], result: [0, 2] }]);

    expect(elements["scroll-result"].scrollTop).toBe(0);
  });

  it("navigates from wherever the user scrolled to", () => {
    const { elements, document } = startClient();
    const result = elements["scroll-result"];
    result.scrollTop = 200;

    // The navigation line is (200 + 25) / 20 = 11.25, so the previous block starts at result line 9.
    document.fire("keydown", { key: "F7", shiftKey: true });
    expect(result.scrollTop).toBe(9 * 20 - 25);
  });

  it("disables navigation when there are no differences", () => {
    const { elements } = startClient([]);

    expect(elements.prev.disabled).toBe(true);
    expect(elements.next.disabled).toBe(true);
  });

  it("ignores horizontal-only scrolling", () => {
    const { elements } = startClient();
    const base = elements["scroll-base"];
    const result = elements["scroll-result"];
    result.scrollTop = 120;

    base.fire("scroll");

    expect(result.scrollTop).toBe(120);
  });

  it("follows a user scroll in the other pane without echoing it back", () => {
    const { elements } = startClient();
    const base = elements["scroll-base"];
    const result = elements["scroll-result"];

    base.scrollTop = 50;
    base.fire("scroll");
    expect(result.scrollTop).toBe(10);

    result.fire("scroll");
    expect(base.scrollTop).toBe(50);
  });

  it("redraws visible connectors on the next frame", () => {
    const { elements, flushFrames } = startClient();

    flushFrames();

    expect(elements.connectors.children.length).toBeGreaterThan(0);
  });

  it("restores both panes after a re-render of the same comparison instead of jumping to the first difference", () => {
    const before = startClient();
    before.elements["scroll-base"].scrollTop = 120;
    before.elements["scroll-result"].scrollTop = 80;
    before.elements["scroll-result"].fire("scroll");

    const after = startClient(BLOCKS, { state: before.savedState() });

    expect(after.elements["scroll-base"].scrollTop).toBe(120);
    expect(after.elements["scroll-result"].scrollTop).toBe(80);
  });

  it("starts at the first difference when the saved offsets belong to another comparison", () => {
    const before = startClient();
    before.elements["scroll-result"].scrollTop = 200;
    before.elements["scroll-result"].fire("scroll");

    const after = startClient(BLOCKS, { title: "util.ts (a ↔ b)", state: before.savedState() });

    expect(after.elements["scroll-result"].scrollTop).toBe(2 * 20 - 25);
  });

  it("does not sync one restored pane into the other", () => {
    const before = startClient();
    before.elements["scroll-base"].scrollTop = 120;
    before.elements["scroll-result"].scrollTop = 80;
    before.elements["scroll-result"].fire("scroll");
    const after = startClient(BLOCKS, { state: before.savedState() });

    after.elements["scroll-base"].fire("scroll");
    after.elements["scroll-result"].fire("scroll");

    expect(after.elements["scroll-base"].scrollTop).toBe(120);
    expect(after.elements["scroll-result"].scrollTop).toBe(80);
  });
});

describe("diff client current change", () => {
  it("marks the first change on both sides when a file opens", () => {
    const { elements } = startClient();

    expect(markedRows(elements, "base")).toEqual([2, 4]);
    expect(markedRows(elements, "result")).toEqual([2, 2]);
    expect(elements["current-result"].classList.contains("is-empty")).toBe(true);
    expect(elements["current-base"].classList.contains("is-empty")).toBe(false);
  });

  it("moves the mark with F7 and Shift+F7", () => {
    const { elements, document } = startClient();

    document.fire("keydown", { key: "F7" });
    expect(markedRows(elements, "base")).toEqual([6, 6]);
    expect(markedRows(elements, "result")).toEqual([4, 7]);

    document.fire("keydown", { key: "F7", shiftKey: true });
    expect(markedRows(elements, "result")).toEqual([2, 2]);
  });

  it("marks the last change of a file opened at its last change", () => {
    const { elements } = startClient(BLOCKS, { startAt: "last" });

    expect(markedRows(elements, "base")).toEqual([8, 9]);
    expect(markedRows(elements, "result")).toEqual([9, 12]);
  });

  it("keeps the mark on the last change when F7 finds no further one", () => {
    const { elements, document } = startClient(BLOCKS, { startAt: "last" });

    document.fire("keydown", { key: "F7" });

    expect(markedRows(elements, "result")).toEqual([9, 12]);
  });

  it("keeps an empty range's bar inside the pane at its first and last line", () => {
    const atEdges: ClientBlock[] = [
      { kind: "deleted", base: [0, 2], result: [0, 0] },
      { kind: "added", base: [12, 12], result: [13, 15] },
    ];
    const { elements, document } = startClient(atEdges);
    const result = elements["current-result"];
    const base = elements["current-base"];

    expect(result.classList.contains("at-top")).toBe(true);
    expect(result.classList.contains("at-bottom")).toBe(false);

    document.fire("keydown", { key: "F7" });

    expect(base.classList.contains("at-bottom")).toBe(true);
    expect(base.classList.contains("at-top")).toBe(false);
    expect(result.classList.contains("at-top")).toBe(false);
  });

  it("spans the visible width of each pane, following sideways scrolling", () => {
    const { elements } = startClient();
    expect(elements["current-result"].style.left).toBe("0px");
    expect(elements["current-base"].style.width).toBe("40px");

    elements["scroll-result"].scrollLeft = 30;
    elements["scroll-result"].fire("scroll");

    expect(elements["current-result"].style.left).toBe("30px");
    expect(elements["current-result"].style.width).toBe("40px");
    expect(elements["current-base"].style.left).toBe("0px");
  });

  it("steps from the marked change while it is in view, not from the viewport", () => {
    const nearEnd: ClientBlock[] = [
      { kind: "modified", base: [2, 3], result: [2, 3] },
      { kind: "modified", base: [17, 18], result: [17, 18] },
      { kind: "modified", base: [19, 20], result: [19, 20] },
    ];
    const { elements, document } = startClient(nearEnd);
    const result = elements["scroll-result"];
    document.fire("keydown", { key: "F7" });
    document.fire("keydown", { key: "F7" });

    // Rows 14-19 in view, the marked block 19-20 at the bottom edge.
    result.scrollTop = 280;
    result.fire("scroll");
    document.fire("keydown", { key: "F7" });
    expect(markedRows(elements, "result")).toEqual([19, 20]);

    document.fire("keydown", { key: "F7", shiftKey: true });
    expect(markedRows(elements, "result")).toEqual([17, 18]);
  });

  it("marks nothing after restoring a re-render's scroll offsets", () => {
    const before = startClient();
    before.elements["scroll-result"].scrollTop = 80;
    before.elements["scroll-result"].fire("scroll");

    const after = startClient(BLOCKS, { state: before.savedState() });

    expect(markedRows(after.elements, "result")).toBeNull();
    expect(markedRows(after.elements, "base")).toBeNull();
  });

  it("outlines the current change's ribbon", () => {
    const { elements, flushFrames } = startClient();

    flushFrames();

    const classes = (elements.connectors.children as FakeElement[]).map((path) => path.attributes.class);
    // The third block is below the 100px viewport, so it has no ribbon.
    expect(classes).toEqual(["conn conn-deleted conn-current", "conn conn-added"]);
  });
});

describe("diff client file steps", () => {
  const BOTH_FILES = { hasPrevious: true, hasNext: true } as const;
  const NEXT_HINT = "Press F7 again to go to the next file";
  const PREVIOUS_HINT = "Press Shift+F7 again to go to the previous file";
  /** How long a hint waits for the same key again. */
  const STEP_WINDOW_MS = 2_500;

  afterEach(() => vi.useRealTimers());

  /** Steps to the last block of {@link BLOCKS}, which can still scroll. */
  function startAtLastBlock(start: ClientStart = { files: BOTH_FILES }): Harness {
    const harness = startClient(BLOCKS, start);
    harness.document.fire("keydown", { key: "F7" });
    harness.document.fire("keydown", { key: "F7" });
    expect(harness.elements["scroll-result"].scrollTop).toBe(9 * 20 - 25);
    return harness;
  }

  it("offers the next file on F7 at the last change without opening it", () => {
    vi.useFakeTimers();
    const { document, elements, messages } = startAtLastBlock();

    document.fire("keydown", { key: "F7" });

    expect(elements["file-step"].textContent).toBe(NEXT_HINT);
    expect(messages).toEqual([{ type: "ready" }]);
    expect(elements["scroll-result"].scrollTop).toBe(9 * 20 - 25);
  });

  it("opens the next file when F7 is pressed again within the hint's time", () => {
    vi.useFakeTimers();
    const { document, elements, messages } = startAtLastBlock();

    document.fire("keydown", { key: "F7" });
    vi.advanceTimersByTime(STEP_WINDOW_MS - 1);
    document.fire("keydown", { key: "F7" });

    expect(messages).toEqual([{ type: "ready" }, { type: "openAdjacentFile", direction: "next" }]);
    expect(elements["file-step"].textContent).toBe("");
  });

  it("hides the hint after its time and treats a later F7 as a first press", () => {
    vi.useFakeTimers();
    const { document, elements, messages } = startAtLastBlock();

    document.fire("keydown", { key: "F7" });
    vi.advanceTimersByTime(STEP_WINDOW_MS);
    expect(elements["file-step"].textContent).toBe("");

    document.fire("keydown", { key: "F7" });

    expect(elements["file-step"].textContent).toBe(NEXT_HINT);
    expect(messages).toEqual([{ type: "ready" }]);
  });

  it("says there are no more files after the last file's last change", () => {
    vi.useFakeTimers();
    const { document, elements, messages } = startAtLastBlock({ files: { hasPrevious: true, hasNext: false } });

    document.fire("keydown", { key: "F7" });
    expect(elements["file-step"].textContent).toBe("No more files");
    document.fire("keydown", { key: "F7" });

    expect(elements["file-step"].textContent).toBe("No more files");
    expect(messages).toEqual([{ type: "ready" }]);
  });

  it("ends the offer when a toolbar button moves the view", () => {
    vi.useFakeTimers();
    const { document, elements, messages } = startAtLastBlock();

    document.fire("keydown", { key: "F7" });
    elements.prev.fire("click");
    expect(elements["file-step"].textContent).toBe("");
    elements.next.fire("click");
    document.fire("keydown", { key: "F7" });

    expect(elements["file-step"].textContent).toBe(NEXT_HINT);
    expect(messages).toEqual([{ type: "ready" }]);
  });

  it("offers and opens the previous file with Shift+F7 at the first change", () => {
    vi.useFakeTimers();
    const { document, elements, messages } = startClient(BLOCKS, { files: BOTH_FILES });

    document.fire("keydown", { key: "F7", shiftKey: true });
    expect(elements["file-step"].textContent).toBe(PREVIOUS_HINT);
    expect(messages).toEqual([{ type: "ready" }]);
    document.fire("keydown", { key: "F7", shiftKey: true });

    expect(messages).toEqual([{ type: "ready" }, { type: "openAdjacentFile", direction: "previous" }]);
  });

  it("says there are no previous files before the first file's first change", () => {
    const { document, elements } = startClient(BLOCKS, { files: { hasPrevious: false, hasNext: true } });

    document.fire("keydown", { key: "F7", shiftKey: true });

    expect(elements["file-step"].textContent).toBe("No previous files");
  });

  it("does not confirm a step with the other key", () => {
    vi.useFakeTimers();
    const { document, elements, messages } = startClient([], { files: BOTH_FILES });

    document.fire("keydown", { key: "F7" });
    document.fire("keydown", { key: "F7", shiftKey: true });

    expect(elements["file-step"].textContent).toBe(PREVIOUS_HINT);
    expect(messages).toEqual([{ type: "ready" }]);
  });

  it("keeps stepping between changes in the middle of a file and clears the hint once it moves", () => {
    vi.useFakeTimers();
    const { document, elements, messages } = startClient(BLOCKS, { files: BOTH_FILES });

    document.fire("keydown", { key: "F7", shiftKey: true });
    document.fire("keydown", { key: "F7" });

    expect(elements["scroll-result"].scrollTop).toBe(4 * 20 - 25);
    expect(elements["file-step"].textContent).toBe("");
    document.fire("keydown", { key: "F7", shiftKey: true });
    expect(elements["file-step"].textContent).toBe("");
    expect(messages).toEqual([{ type: "ready" }]);
  });

  it("keeps today's behaviour when the diff has no file list", () => {
    vi.useFakeTimers();
    const { document, elements, messages } = startAtLastBlock({});

    document.fire("keydown", { key: "F7" });
    document.fire("keydown", { key: "F7" });

    expect(elements["file-step"].textContent).toBe("");
    expect(messages).toEqual([{ type: "ready" }]);
  });

  it("starts at the last change of a file reached with Shift+F7", () => {
    const { elements } = startClient(BLOCKS, { files: BOTH_FILES, startAt: "last" });

    expect(elements["scroll-result"].scrollTop).toBe(9 * 20 - 25);
  });
});

describe("diff client working copy", () => {
  it("asks with F4 for the working copy at the marked change, keeping the key from VS Code", () => {
    const { document, messages } = startClient();
    document.fire("keydown", { key: "F7" });

    const event = document.fire("keydown", { key: "F4" });

    expect(messages).toEqual([{ type: "ready" }, { type: "openWorkingCopy", line: 4 }]);
    expect(event).toEqual({ isDefaultPrevented: true, isPropagationStopped: true });
  });

  it("asks for the top visible line once the marked change is out of view", () => {
    const { elements, document, messages } = startClient();
    const result = elements["scroll-result"];
    result.scrollTop = 250;
    result.fire("scroll");

    document.fire("keydown", { key: "F4" });

    expect(messages.at(-1)).toEqual({ type: "openWorkingCopy", line: 12 });
  });

  it("asks for the top visible line when no change is marked", () => {
    const { document, messages } = startClient([]);

    document.fire("keydown", { key: "F4" });

    expect(messages.at(-1)).toEqual({ type: "openWorkingCopy", line: 0 });
  });

  it("leaves F4 with a modifier to VS Code", () => {
    const { document, messages } = startClient();

    const events = [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }].map((modifier) =>
      document.fire("keydown", { key: "F4", ...modifier }),
    );

    expect(messages).toEqual([{ type: "ready" }]);
    expect(events.every((event) => !event.isDefaultPrevented && !event.isPropagationStopped)).toBe(true);
  });

  it("leaves F4 everywhere else in VS Code alone: the extension binds no F4 key", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(MEDIA_ROOT, "..", "package.json"), "utf8")) as {
      contributes: { keybindings?: ReadonlyArray<{ key: string }> };
    };
    const keys = (manifest.contributes.keybindings ?? []).map((binding) => binding.key.toLowerCase());

    expect(keys.filter((key) => key.split(/[+ ]/).includes("f4"))).toEqual([]);
  });
});
