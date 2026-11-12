// Two-way diff client. The geometry helpers at the top are plain functions so
// tests can load this file in a bare VM context and call them; the DOM wiring
// below runs only inside a webview, where acquireVsCodeApi exists.
//
// Positions are measured in lines: every `.line` has the same height, so a
// line index times the line height is its offset inside its scroller.

/**
 * Corresponding points of the two sides, in order: the start, both edges of
 * every block, and the end. Between two anchors the sides map linearly — 1:1
 * between blocks, proportionally inside one.
 */
function buildAnchors(blocks, baseLineCount, resultLineCount) {
  const anchors = [{ base: 0, result: 0 }];
  for (const block of blocks) {
    anchors.push({ base: block.base[0], result: block.result[0] });
    anchors.push({ base: block.base[1], result: block.result[1] });
  }
  anchors.push({ base: baseLineCount, result: resultLineCount });
  return anchors;
}

/** Maps a (fractional) line of side `from` to the matching line of side `to`. */
function mapLine(anchors, line, from, to) {
  for (let index = 0; index + 1 < anchors.length; index++) {
    const start = anchors[index];
    const end = anchors[index + 1];
    const span = end[from] - start[from];
    const isInSegment = span > 0 && line >= start[from] && line <= end[from];
    if (isInSegment) {
      return start[to] + ((line - start[from]) / span) * (end[to] - start[to]);
    }
  }
  const last = anchors[anchors.length - 1];
  const edge = line < 0 ? anchors[0] : last;
  return edge[to] + (line - edge[from]);
}

/**
 * The scroll offset that shows, at the middle of the target viewport, what
 * sits at the middle of the source viewport. Both ends stay pinned so the
 * first and last lines are always reachable on both sides.
 *
 * `source` is { top, height, max }; `target` is { height, max }.
 */
function syncedScrollTop(anchors, from, to, source, target, lineHeight) {
  if (source.top <= 0) {
    return 0;
  }
  if (source.top >= source.max) {
    return target.max;
  }
  const centreLine = (source.top + source.height / 2) / lineHeight;
  const mapped = mapLine(anchors, centreLine, from, to) * lineHeight - target.height / 2;
  return Math.min(Math.max(mapped, 0), target.max);
}

/**
 * IntelliJ's ribbon: a band joining the left block [leftTop, leftBottom] to the
 * right block [rightTop, rightBottom] with S-curves; an empty side tapers to a point.
 */
function connectorPath(width, leftTop, leftBottom, rightTop, rightBottom) {
  const middle = width / 2;
  return [
    `M0,${leftTop}`,
    `C${middle},${leftTop} ${middle},${rightTop} ${width},${rightTop}`,
    `L${width},${rightBottom}`,
    `C${middle},${rightBottom} ${middle},${leftBottom} 0,${leftBottom}`,
    "Z",
  ].join(" ");
}

/** Whether a vertical band [top, bottom] touches the visible strip [0, height]. */
function isBandVisible(top, bottom, height) {
  return bottom >= 0 && top <= height;
}

/**
 * The block after (`direction` 1) or before (-1) `line` on `side`, ignoring a
 * block starting within half a line of it; -1 when there is none.
 */
function neighbourBlock(blocks, side, line, direction) {
  if (direction > 0) {
    return blocks.findIndex((block) => block[side][0] > line + 0.5);
  }
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index][side][0] < line - 0.5) {
      return index;
    }
  }
  return -1;
}

(function () {
  "use strict";

  if (typeof acquireVsCodeApi !== "function") {
    return;
  }

  /** Fraction of the viewport above a block navigated to. */
  const NAVIGATION_OFFSET = 0.25;
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const SIDES = ["base", "result"];

  const vscode = acquireVsCodeApi();
  const diffJson = document.getElementById("diff").dataset.diff;
  const data = JSON.parse(diffJson);
  const anchors = buildAnchors(data.blocks, data.baseLineCount, data.resultLineCount);
  const scrollers = { base: document.getElementById("scroll-base"), result: document.getElementById("scroll-result") };
  const svg = document.getElementById("connectors");

  /** Offsets this script set and must not echo back to the other pane. */
  const expectedTop = { base: null, result: null };
  /** Vertical offsets last synced from, so horizontal scrolling never moves the other pane. */
  const lastTop = { base: 0, result: 0 };
  let lineHeight = measureLineHeight();
  let isDrawScheduled = false;
  /** Block last navigated to, and the result offset that left it in view. */
  let navigation = { index: -1, top: -1 };
  /**
   * Webview state outlives a re-render, such as after a colour theme change, but the reused tab may now show another
   * file; the saved offsets apply only to the same comparison, told apart by its title and difference blocks.
   */
  const scrollStateKey = `${document.title}\n${diffJson}`;

  function measureLineHeight() {
    const line = scrollers.result.querySelector(".line") || scrollers.base.querySelector(".line");
    return line ? line.getBoundingClientRect().height || 1 : 1;
  }

  function viewport(scroller) {
    return {
      top: scroller.scrollTop,
      height: scroller.clientHeight,
      max: Math.max(scroller.scrollHeight - scroller.clientHeight, 0),
    };
  }

  function onScroll(side) {
    vscode.setState({ key: scrollStateKey, base: scrollers.base.scrollTop, result: scrollers.result.scrollTop });
    const top = scrollers[side].scrollTop;
    const expected = expectedTop[side];
    expectedTop[side] = null;
    scheduleDraw();
    if (Math.abs(top - lastTop[side]) < 1) {
      return;
    }
    lastTop[side] = top;
    if (expected !== null && Math.abs(top - expected) < 1) {
      return;
    }
    syncFrom(side);
  }

  function syncFrom(side) {
    const other = side === "base" ? "result" : "base";
    const target = scrollers[other];
    const top = syncedScrollTop(anchors, side, other, viewport(scrollers[side]), viewport(target), lineHeight);
    if (Math.abs(target.scrollTop - top) < 1) {
      return;
    }
    target.scrollTop = top;
    // Read back: the browser may round or clamp, and an unchanged offset fires no event.
    expectedTop[other] = target.scrollTop;
  }

  function scheduleDraw() {
    if (isDrawScheduled) {
      return;
    }
    isDrawScheduled = true;
    requestAnimationFrame(() => {
      isDrawScheduled = false;
      drawConnectors();
    });
  }

  function drawConnectors() {
    const width = svg.clientWidth;
    const height = svg.clientHeight;
    const baseTop = scrollers.base.scrollTop;
    const resultTop = scrollers.result.scrollTop;
    const paths = [];

    for (const block of data.blocks) {
      const leftTop = block.base[0] * lineHeight - baseTop;
      const leftBottom = block.base[1] * lineHeight - baseTop;
      const rightTop = block.result[0] * lineHeight - resultTop;
      const rightBottom = block.result[1] * lineHeight - resultTop;
      const isVisible = isBandVisible(leftTop, leftBottom, height) || isBandVisible(rightTop, rightBottom, height);
      if (!isVisible) {
        continue;
      }
      const path = document.createElementNS(SVG_NAMESPACE, "path");
      path.setAttribute("class", `conn conn-${block.kind}`);
      path.setAttribute("d", connectorPath(width, leftTop, leftBottom, rightTop, rightBottom));
      paths.push(path);
    }
    svg.replaceChildren(...paths);
  }

  /** Steps past blocks that would not move the view, such as several in the last screenful. */
  function navigate(direction) {
    const scroller = scrollers.result;
    const offset = scroller.clientHeight * NAVIGATION_OFFSET;
    const isStillAtLastTarget = navigation.index !== -1 && Math.abs(scroller.scrollTop - navigation.top) < 1;
    const first = isStillAtLastTarget
      ? navigation.index + direction
      : neighbourBlock(data.blocks, "result", (scroller.scrollTop + offset) / lineHeight, direction);
    for (let index = first; index >= 0 && index < data.blocks.length; index += direction) {
      if (goTo(index)) {
        return;
      }
    }
  }

  /** Scrolls block `index` into view near the top; returns whether the view moved. */
  function goTo(index) {
    const scroller = scrollers.result;
    const before = scroller.scrollTop;
    scroller.scrollTop = data.blocks[index].result[0] * lineHeight - scroller.clientHeight * NAVIGATION_OFFSET;
    navigation = { index, top: scroller.scrollTop };
    return Math.abs(scroller.scrollTop - before) >= 1;
  }

  /** Puts both panes back where they were without syncing one from the other. */
  function restoreScroll(saved) {
    for (const side of SIDES) {
      scrollers[side].scrollTop = saved[side];
      // Only a moved pane fires a scroll event that consumes the expectation.
      expectedTop[side] = scrollers[side].scrollTop > 0 ? scrollers[side].scrollTop : null;
    }
  }

  for (const side of SIDES) {
    scrollers[side].addEventListener("scroll", () => onScroll(side), { passive: true });
  }
  window.addEventListener("resize", () => {
    lineHeight = measureLineHeight();
    syncFrom("result");
    scheduleDraw();
  });
  document.getElementById("prev").addEventListener("click", () => navigate(-1));
  document.getElementById("next").addEventListener("click", () => navigate(1));
  document.getElementById("open-native").addEventListener("click", () => vscode.postMessage({ type: "openNative" }));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "F7") {
      return;
    }
    event.preventDefault();
    navigate(event.shiftKey ? -1 : 1);
  });

  for (const button of [document.getElementById("prev"), document.getElementById("next")]) {
    button.disabled = data.blocks.length === 0;
  }
  const saved = vscode.getState();
  if (saved && saved.key === scrollStateKey) {
    restoreScroll(saved);
  } else if (data.blocks.length > 0) {
    goTo(0);
  }
  scheduleDraw();
  vscode.postMessage({ type: "ready" });
})();
