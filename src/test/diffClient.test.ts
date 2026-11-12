import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";

const CLIENT_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "media", "diff.js"), "utf8");

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

/** The pure geometry the script defines at top level, read from a context without `acquireVsCodeApi`. */
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
  vm.runInNewContext(CLIENT_SOURCE, context);
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

type Listener = (event: { key?: string; shiftKey?: boolean; preventDefault(): void }) => void;

/** Scroll offsets clamp to the scrollable range, as in a browser. */
class FakeElement {
  private top = 0;
  clientHeight = 100;
  scrollHeight = 400;
  clientWidth = 40;
  disabled = false;
  readonly dataset: Record<string, string> = {};
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

  fire(type: string, init: { key?: string; shiftKey?: boolean } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ ...init, preventDefault: () => undefined });
    }
  }

  querySelector(): { getBoundingClientRect(): { height: number } } {
    return { getBoundingClientRect: () => ({ height: 20 }) };
  }

  replaceChildren(...children: unknown[]): void {
    this.children = children;
  }

  setAttribute(): void {}
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
}

function startClient(blocks: readonly ClientBlock[] = BLOCKS, start: ClientStart = {}): Harness {
  const ids = ["diff", "scroll-base", "scroll-result", "connectors", "prev", "next", "open-native"];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements.diff.dataset.diff = JSON.stringify({ blocks, baseLineCount: BASE_LINES, resultLineCount: RESULT_LINES });
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

  it("skips blocks that cannot scroll any further near the end", () => {
    const nearEnd: ClientBlock[] = [
      { kind: "modified", base: [2, 3], result: [2, 3] },
      { kind: "modified", base: [17, 18], result: [17, 18] },
      { kind: "modified", base: [19, 20], result: [19, 20] },
    ];
    const { elements, document } = startClient(nearEnd);
    const result = elements["scroll-result"];

    document.fire("keydown", { key: "F7" });
    expect(result.scrollTop).toBe(300);

    document.fire("keydown", { key: "F7" });
    expect(result.scrollTop).toBe(300);

    document.fire("keydown", { key: "F7", shiftKey: true });
    expect(result.scrollTop).toBe(2 * 20 - 25);
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
