// Two-way diff client. The geometry it uses comes from diffGeometry.js, which
// the page loads first; this wiring runs only inside a webview, where
// acquireVsCodeApi exists.

(function () {
  "use strict";

  if (typeof acquireVsCodeApi !== "function") {
    return;
  }

  /** Fraction of the viewport above a block navigated to. */
  const NAVIGATION_OFFSET = 0.25;
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const SIDES = ["base", "result"];
  /** How long the hint at either end of a file shows and waits for the same key again. */
  const FILE_STEP_WINDOW_MS = 2500;

  const vscode = acquireVsCodeApi();
  const diffElement = document.getElementById("diff");
  const diffJson = diffElement.dataset.diff;
  const data = JSON.parse(diffJson);
  /** The neighbours in the comparison's file list, or null when this diff has no list and F7 stops at the ends. */
  const fileList = diffElement.dataset.files ? JSON.parse(diffElement.dataset.files) : null;
  const fileStepHint = document.getElementById("file-step");
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
  /** The file step a repeated F7 or Shift+F7 confirms while its hint shows: `direction` and the hint's timer. */
  let pendingFileStep = null;
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

  /** Steps past blocks that would not move the view, such as several in the last screenful; returns whether it moved. */
  function navigate(direction) {
    const scroller = scrollers.result;
    const offset = scroller.clientHeight * NAVIGATION_OFFSET;
    const isStillAtLastTarget = navigation.index !== -1 && Math.abs(scroller.scrollTop - navigation.top) < 1;
    const first = isStillAtLastTarget
      ? navigation.index + direction
      : neighbourBlock(data.blocks, "result", (scroller.scrollTop + offset) / lineHeight, direction);
    for (let index = first; index >= 0 && index < data.blocks.length; index += direction) {
      if (goTo(index)) {
        return true;
      }
    }
    return false;
  }

  /**
   * F7 and Shift+F7: the next or previous change, or at either end of a file in a list, a hint offering the
   * neighbouring file, which the same key opens while the hint shows.
   */
  function navigateByKey(direction) {
    const hasMoved = navigate(direction);
    if (hasMoved || fileList === null) {
      endFileStep();
      return;
    }
    const hasFile = direction > 0 ? fileList.hasNext : fileList.hasPrevious;
    const isConfirmed = pendingFileStep !== null && pendingFileStep.direction === direction;
    if (isConfirmed && hasFile) {
      endFileStep();
      vscode.postMessage({ type: "openAdjacentFile", direction: direction > 0 ? "next" : "previous" });
      return;
    }
    offerFileStep(direction, hasFile);
  }

  function offerFileStep(direction, hasFile) {
    endFileStep();
    const hints = direction > 0
      ? ["Press F7 again to go to the next file", "No more files"]
      : ["Press Shift+F7 again to go to the previous file", "No previous files"];
    fileStepHint.textContent = hasFile ? hints[0] : hints[1];
    pendingFileStep = { direction, timer: setTimeout(endFileStep, FILE_STEP_WINDOW_MS) };
  }

  function endFileStep() {
    if (pendingFileStep === null) {
      return;
    }
    clearTimeout(pendingFileStep.timer);
    pendingFileStep = null;
    fileStepHint.textContent = "";
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
  // The buttons stay within the file; a click ends any offer of the next or previous file.
  document.getElementById("prev").addEventListener("click", () => {
    endFileStep();
    navigate(-1);
  });
  document.getElementById("next").addEventListener("click", () => {
    endFileStep();
    navigate(1);
  });
  document.getElementById("open-native").addEventListener("click", () => vscode.postMessage({ type: "openNative" }));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "F7") {
      return;
    }
    event.preventDefault();
    navigateByKey(event.shiftKey ? -1 : 1);
  });

  for (const button of [document.getElementById("prev"), document.getElementById("next")]) {
    button.disabled = data.blocks.length === 0;
  }
  const saved = vscode.getState();
  if (saved && saved.key === scrollStateKey) {
    restoreScroll(saved);
  } else if (data.blocks.length > 0) {
    goTo(diffElement.dataset.startAt === "last" ? data.blocks.length - 1 : 0);
  }
  scheduleDraw();
  vscode.postMessage({ type: "ready" });
})();
