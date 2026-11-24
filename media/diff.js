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
  /** The status's number while no change is marked. */
  const NO_CURRENT_NUMBER = "–";

  const vscode = acquireVsCodeApi();
  const diffElement = document.getElementById("diff");
  const diffJson = diffElement.dataset.diff;
  const data = JSON.parse(diffJson);
  /** Stamped on every message, so the host can drop those this page sends after another diff replaced it. */
  const page = Number(diffElement.dataset.page);

  function post(message) {
    vscode.postMessage({ ...message, page });
  }

  /**
   * The neighbours in the comparison's file list, or null when this diff has no list and F7 stops at the ends. While
   * `isPending`, the host is still looking for them and sends them in a `fileList` message.
   */
  let fileList = diffElement.dataset.files ? JSON.parse(diffElement.dataset.files) : null;
  const fileStepHint = document.getElementById("file-step");
  /** The marked change's number in the status; absent when there are no differences. */
  const currentNumber = document.getElementById("current-number");
  const status = document.getElementById("status");
  const anchors = buildAnchors(data.blocks, data.baseLineCount, data.resultLineCount);
  const scrollers = { base: document.getElementById("scroll-base"), result: document.getElementById("scroll-result") };
  const svg = document.getElementById("connectors");
  const currentMarkers = {
    base: document.getElementById("current-base"),
    result: document.getElementById("current-result"),
  };

  /** Offsets this script set and must not echo back to the other pane. */
  const expectedTop = { base: null, result: null };
  /** Vertical offsets last synced from, so horizontal scrolling never moves the other pane. */
  const lastTop = { base: 0, result: 0 };
  let lineHeight = measureLineHeight();
  let isDrawScheduled = false;
  /** Index of the block last navigated to, which the marker shows; -1 before any navigation. */
  let currentIndex = -1;
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
    fitMarker(side);
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
      const current = block === data.blocks[currentIndex] ? " conn-current" : "";
      path.setAttribute("class", `conn conn-${block.kind}${current}`);
      path.setAttribute("d", connectorPath(width, leftTop, leftBottom, rightTop, rightBottom));
      paths.push(path);
    }
    svg.replaceChildren(...paths);
  }

  /**
   * Goes to the next or previous block: after the marked one while it is in view, else after the viewport. Blocks
   * that cannot scroll any further still count, since the marker shows the step. Returns whether there was a block to
   * go to.
   */
  function navigate(direction) {
    const scroller = scrollers.result;
    const offset = scroller.clientHeight * NAVIGATION_OFFSET;
    const index = isMarkedInView()
      ? currentIndex + direction
      : neighbourBlock(data.blocks, "result", (scroller.scrollTop + offset) / lineHeight, direction);
    if (index < 0 || index >= data.blocks.length) {
      return false;
    }
    goTo(index);
    return true;
  }

  /**
   * F7 and Shift+F7: the next or previous change, or at either end of a file in a list, a hint offering the
   * neighbouring file, which the same key opens while the hint shows.
   */
  function navigateByKey(direction) {
    const hasStepped = navigate(direction);
    if (hasStepped || fileList === null) {
      endFileStep();
      return;
    }
    const isConfirmed = pendingFileStep !== null && pendingFileStep.direction === direction;
    if (isConfirmed && hasFileTowards(direction)) {
      endFileStep();
      post({ type: "openAdjacentFile", direction: direction > 0 ? "next" : "previous" });
      return;
    }
    offerFileStep(direction);
  }

  /** Whether the file list has a file to open that way; never while the host is still looking for one. */
  function hasFileTowards(direction) {
    return !fileList.isPending && (direction > 0 ? fileList.hasNext : fileList.hasPrevious);
  }

  function offerFileStep(direction) {
    endFileStep();
    const hint = fileStepHintOf(direction);
    fileStepHint.textContent = hint.text;
    fileStepHint.title = hint.title;
    pendingFileStep = { direction, timer: setTimeout(endFileStep, FILE_STEP_WINDOW_MS) };
  }

  /** The hint's text, and its tooltip, which says what pressing the key again does. */
  function fileStepHintOf(direction) {
    if (fileList.isPending) {
      return direction > 0
        ? { text: "Looking for the next file…", title: "Still reading the Changed files list for the next file with differences to show; F7 can open it once found" }
        : { text: "Looking for the previous file…", title: "Still reading the Changed files list for the previous file with differences to show; Shift+F7 can open it once found" };
    }
    const seconds = FILE_STEP_WINDOW_MS / 1000;
    const hasFile = hasFileTowards(direction);
    if (direction > 0) {
      return hasFile
        ? { text: "Press F7 again to go to the next file", title: `Press F7 again within ${seconds} seconds to open the next file of the Changed files list at its first difference` }
        : { text: "No more files", title: "No later file of the Changed files list has differences to show" };
    }
    return hasFile
      ? { text: "Press Shift+F7 again to go to the previous file", title: `Press Shift+F7 again within ${seconds} seconds to open the previous file of the Changed files list at its last difference` }
      : { text: "No previous files", title: "No earlier file of the Changed files list has differences to show" };
  }

  function endFileStep() {
    if (pendingFileStep === null) {
      return;
    }
    clearTimeout(pendingFileStep.timer);
    pendingFileStep = null;
    fileStepHint.textContent = "";
    fileStepHint.title = "";
  }

  /**
   * F4: the working file at the marked change while it is in view, as F7 steps from it, else at the top visible line.
   * The key stops here: the webview host forwards keys to the workbench from the window, where F4 means the next
   * search result.
   */
  function openWorkingCopy(event) {
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const line = isMarkedInView()
      ? data.blocks[currentIndex].result[0]
      : Math.floor(scrollers.result.scrollTop / lineHeight);
    post({ type: "openWorkingCopy", line });
  }

  /** Scrolls block `index` into view near the top and marks it as the current change. */
  function goTo(index) {
    const scroller = scrollers.result;
    scroller.scrollTop = data.blocks[index].result[0] * lineHeight - scroller.clientHeight * NAVIGATION_OFFSET;
    currentIndex = index;
    markCurrent(data.blocks[index]);
    showCurrentNumber();
    scheduleDraw();
  }

  function isMarkedInView() {
    if (currentIndex === -1) {
      return false;
    }
    const scroller = scrollers.result;
    const [start, end] = data.blocks[currentIndex].result.map((line) => line * lineHeight - scroller.scrollTop);
    return isBandVisible(start, end, scroller.clientHeight);
  }

  /**
   * Outlines `block`'s rows on both sides; an empty range becomes a bar on the line where the other side's rows go,
   * kept inside the pane at its first and last line.
   */
  function markCurrent(block) {
    for (const side of SIDES) {
      const [start, end] = block[side];
      const lineCount = side === "base" ? data.baseLineCount : data.resultLineCount;
      const isEmpty = start === end;
      const marker = currentMarkers[side];
      // Rows in --row-height units follow font and zoom changes without measuring.
      marker.style.top = `calc(${start} * var(--row-height))`;
      marker.style.height = `calc(${end - start} * var(--row-height))`;
      marker.classList.toggle("is-empty", isEmpty);
      marker.classList.toggle("at-top", isEmpty && start === 0);
      marker.classList.toggle("at-bottom", isEmpty && start === lineCount);
      fitMarker(side);
      marker.hidden = false;
    }
  }

  /** The status's number and tooltip, worded as the renderer words them. */
  function showCurrentNumber() {
    if (currentNumber === null) {
      return;
    }
    const count = data.blocks.length;
    const isMarked = currentIndex !== -1;
    currentNumber.textContent = isMarked ? String(currentIndex + 1) : NO_CURRENT_NUMBER;
    status.title = isMarked
      ? `Difference ${currentIndex + 1} of ${count} is marked; F7 / Shift+F7 or ↓/↑ go to the next / previous`
      : `${count} difference${count === 1 ? "" : "s"}, none marked since the view was redrawn; F7 or ↓ goes to the next`;
  }

  /** Spans the marker across the visible width, so the text scrolling sideways leaves its sides in view. */
  function fitMarker(side) {
    const scroller = scrollers[side];
    currentMarkers[side].style.left = `${scroller.scrollLeft}px`;
    currentMarkers[side].style.width = `${scroller.clientWidth}px`;
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
    for (const side of SIDES) {
      fitMarker(side);
    }
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
  document.getElementById("open-native").addEventListener("click", () => post({ type: "openNative" }));
  // The host sends the neighbouring files once it has found them; a hint showing is brought up to date.
  window.addEventListener("message", (event) => {
    const message = event.data;
    const isFileList = typeof message === "object" && message !== null && message.type === "fileList" && message.page === page
      && typeof message.hasPrevious === "boolean" && typeof message.hasNext === "boolean";
    if (!isFileList || fileList === null) {
      return;
    }
    fileList = { hasPrevious: message.hasPrevious, hasNext: message.hasNext };
    if (pendingFileStep !== null) {
      offerFileStep(pendingFileStep.direction);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "F4") {
      openWorkingCopy(event);
      return;
    }
    if (event.key !== "F7") {
      return;
    }
    event.preventDefault();
    navigateByKey(event.shiftKey ? -1 : 1);
  });

  for (const button of [document.getElementById("prev"), document.getElementById("next")]) {
    button.disabled = data.blocks.length === 0;
    if (button.disabled) {
      button.title = "No differences to go to";
    }
  }
  const saved = vscode.getState();
  if (saved && saved.key === scrollStateKey) {
    restoreScroll(saved);
    // A restored view marks no change.
    showCurrentNumber();
  } else if (data.blocks.length > 0) {
    goTo(diffElement.dataset.startAt === "last" ? data.blocks.length - 1 : 0);
  }
  scheduleDraw();
  post({ type: "ready" });
})();
