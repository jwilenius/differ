import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";

const RULER_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "media", "overviewRuler.js"), "utf8");

interface Span {
  readonly top: number;
  readonly height: number;
}

/** The pure geometry `overviewRuler.js` defines at top level. */
interface OverviewGeometry {
  overviewMark(band: { top: number; bottom: number }, contentHeight: number, rulerHeight: number): Span;
  overviewViewportBox(viewport: Span, contentHeight: number, rulerHeight: number): Span;
  overviewContentOffset(rulerOffset: number, contentHeight: number, rulerHeight: number): number;
}

function loadGeometry(): OverviewGeometry {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(RULER_SOURCE, context);
  return context as unknown as OverviewGeometry;
}

describe("overview ruler geometry", () => {
  const geometry = loadGeometry();

  it("scales a change's band from the content to the ruler", () => {
    // 2000px of content on a 500px ruler: a quarter.
    expect(geometry.overviewMark({ top: 400, bottom: 800 }, 2000, 500)).toEqual({ top: 100, height: 100 });
  });

  it("gives a one-line change and an empty range a visible mark centred on where they are", () => {
    expect(geometry.overviewMark({ top: 1000, bottom: 1004 }, 2000, 500)).toEqual({ top: 249, height: 3 });
    expect(geometry.overviewMark({ top: 1000, bottom: 1000 }, 2000, 500)).toEqual({ top: 248.5, height: 3 });
  });

  it("keeps marks at either end of the file on the ruler", () => {
    expect(geometry.overviewMark({ top: 0, bottom: 0 }, 2000, 500)).toEqual({ top: 0, height: 3 });
    expect(geometry.overviewMark({ top: 2000, bottom: 2000 }, 2000, 500)).toEqual({ top: 497, height: 3 });
  });

  it("boxes the visible part at its scaled place", () => {
    expect(geometry.overviewViewportBox({ top: 1000, height: 400 }, 2000, 500)).toEqual({ top: 250, height: 100 });
  });

  it("boxes the whole ruler when the content fits on screen", () => {
    expect(geometry.overviewViewportBox({ top: 0, height: 300 }, 300, 500)).toEqual({ top: 0, height: 500 });
  });

  it("keeps the box tall enough to grab in a long file, inside the ruler at the end", () => {
    expect(geometry.overviewViewportBox({ top: 0, height: 400 }, 100000, 500)).toEqual({ top: 0, height: 10 });
    expect(geometry.overviewViewportBox({ top: 99600, height: 400 }, 100000, 500)).toEqual({ top: 490, height: 10 });
  });

  it("maps a ruler offset back to the content", () => {
    expect(geometry.overviewContentOffset(125, 2000, 500)).toBe(500);
    expect(geometry.overviewContentOffset(-10, 2000, 500)).toBe(-40);
  });

  it("maps nothing on a ruler without height, as in a hidden page", () => {
    expect(geometry.overviewContentOffset(10, 2000, 0)).toBe(0);
    expect(geometry.overviewMark({ top: 10, bottom: 20 }, 0, 0)).toEqual({ top: 0, height: 0 });
  });
});
