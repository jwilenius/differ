// Two-way diff client. The geometry it uses comes from diffGeometry.js, and the
// overview ruler from overviewRuler.js, which the page loads first; this wiring
// runs only inside a webview, where acquireVsCodeApi exists.

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
   * The neighbours in the comparison's file list, or null when this diff has no list and F7 stops at the ends. A
   * direction where a step found no file to open has none left.
   */
  let fileList = diffElement.dataset.files ? JSON.parse(diffElement.dataset.files) : null;
  const fileStepHint = document.getElementById("file-step");
  /** The marked change's number in the status; absent when there are no differences. */
  const currentNumber = document.getElementById("current-number");
  const status = document.getElementById("status");
  const wrapToggle = document.getElementById("wrap-lines");
  const anchors = buildAnchors(data.blocks, data.baseLineCount, data.resultLineCount);
  const scrollers = { base: document.getElementById("scroll-base"), result: document.getElementById("scroll-result") };
  const svg = document.getElementById("connectors");
  const currentMarkers = {
    base: document.getElementById("current-base"),
    result: document.getElementById("current-result"),
  };
  const overview = attachOverviewRuler(document.getElementById("overview"), scrollers.result);

  /** Offsets this script set and must not echo back to the other pane. */
  const expectedTop = { base: null, result: null };
  /** Vertical offsets last synced from, so horizontal scrolling never moves the other pane. */
  const lastTop = { base: 0, result: 0 };
  let lineHeight = measureLineHeight();
  /** Whether long lines wrap to the panes' width; the webview state keeps it for every file this tab shows. */
  let isWrapping = false;
  /** Each side's row offsets while lines wrap; null while every row is `lineHeight` tall. */
  let wrappedOffsets = null;
  /** The anchors in pixels while lines wrap, for scroll sync; null while rows are uniform. */
  let pixelAnchors = null;
  /** Rows made taller to stay level with their counterpart on the other side. */
  let leveledRows = [];
  /** The panes' widths (`paneWidths`) the wrapped rows were measured at. */
  let measuredWidths = "";
  let isResizeScheduled = false;
  let isDrawScheduled = false;
  /** Index of the block last navigated to, which the marker shows; -1 before any navigation. */
  let currentIndex = -1;
  /**
   * The file step whose hint shows: its `direction`, and either `isOpening` while the host reads the files that way, or
   * the `timer` of the offer a repeated F7 or Shift+F7 confirms.
   */
  let fileStep = null;
  /**
   * Webview state outlives a re-render, such as after a colour theme change, but the reused tab may now show another
   * file; the saved offsets apply only to the same comparison, told apart by its title and difference blocks.
   */
  const scrollStateKey = `${document.title}\n${diffJson}`;

  function measureLineHeight() {
    const line = scrollers.result.querySelector(".line") || scrollers.base.querySelector(".line");
    return line ? line.getBoundingClientRect().height || 1 : 1;
  }

  /** The offset of a (fractional) line's top inside its pane. */
  function lineTop(side, line) {
    return wrappedOffsets === null ? line * lineHeight : offsetOfLine(wrappedOffsets[side], line);
  }

  /** The (fractional) line at an offset inside its pane. */
  function lineAt(side, top) {
    return wrappedOffsets === null ? top / lineHeight : lineAtOffset(wrappedOffsets[side], top);
  }

  function viewport(scroller) {
    return {
      top: scroller.scrollTop,
      height: scroller.clientHeight,
      max: Math.max(scroller.scrollHeight - scroller.clientHeight, 0),
    };
  }

  function saveState() {
    vscode.setState({ key: scrollStateKey, base: scrollers.base.scrollTop, result: scrollers.result.scrollTop, isWrapping });
  }

  function onScroll(side) {
    fitMarker(side);
    saveState();
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
    const top = pixelAnchors === null
      ? syncedScrollTop(anchors, side, other, viewport(scrollers[side]), viewport(target), lineHeight)
      : syncedScrollTop(pixelAnchors, side, other, viewport(scrollers[side]), viewport(target), 1);
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
      const leftTop = lineTop("base", block.base[0]) - baseTop;
      const leftBottom = lineTop("base", block.base[1]) - baseTop;
      const rightTop = lineTop("result", block.result[0]) - resultTop;
      const rightBottom = lineTop("result", block.result[1]) - resultTop;
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
      : neighbourBlock(data.blocks, "result", lineAt("result", scroller.scrollTop + offset), direction);
    if (index < 0 || index >= data.blocks.length) {
      return false;
    }
    goTo(index);
    drawOverview();
    return true;
  }

  /**
   * F7 and Shift+F7: the next or previous change, or at either end of a file in a list, a hint offering the
   * neighbouring file, which the same key opens while the hint shows.
   */
  function navigateByKey(direction) {
    const hasStepped = navigate(direction);
    if (hasStepped || fileList === null) {
      endFileStepOffer();
      return;
    }
    const isHintTowards = fileStep !== null && fileStep.direction === direction;
    if (isHintTowards && fileStep.isOpening) {
      return;
    }
    if (isHintTowards && hasFileTowards(direction)) {
      showFileStep(direction, openingHintOf(direction), true);
      post({ type: "openAdjacentFile", direction: direction > 0 ? "next" : "previous" });
      return;
    }
    offerFileStep(direction);
  }

  /** Whether the file list has a file to open that way. */
  function hasFileTowards(direction) {
    return direction > 0 ? fileList.hasNext : fileList.hasPrevious;
  }

  function offerFileStep(direction) {
    showFileStep(direction, fileStepHintOf(direction), false);
  }

  /** Replaces the hint; an offer ends after its time, an opening hint once the host answers. */
  function showFileStep(direction, hint, isOpening) {
    endFileStep();
    fileStepHint.textContent = hint.text;
    fileStepHint.title = hint.title;
    const timer = isOpening ? null : setTimeout(endFileStep, FILE_STEP_WINDOW_MS);
    fileStep = { direction, isOpening, timer };
  }

  /** Shown while the host reads the files that way for one it can open. */
  function openingHintOf(direction) {
    const which = direction > 0 ? "next" : "previous";
    return { text: `Opening the ${which} file…`, title: `Reading the ${which} files of the Changed files list for one with differences to show` };
  }

  /** The hint's text, and its tooltip, which says what pressing the key again does. */
  function fileStepHintOf(direction) {
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

  /** Moving within the file ends an offer; a step being opened keeps its hint until the host answers. */
  function endFileStepOffer() {
    const isOpening = fileStep !== null && fileStep.isOpening;
    if (!isOpening) {
      endFileStep();
    }
  }

  function endFileStep() {
    if (fileStep === null) {
      return;
    }
    clearTimeout(fileStep.timer);
    fileStep = null;
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
      : Math.floor(lineAt("result", scrollers.result.scrollTop));
    post({ type: "openWorkingCopy", line });
  }

  /** Scrolls block `index` into view near the top and marks it as the current change. */
  function goTo(index) {
    const scroller = scrollers.result;
    scroller.scrollTop = lineTop("result", data.blocks[index].result[0]) - scroller.clientHeight * NAVIGATION_OFFSET;
    currentIndex = index;
    markCurrent(data.blocks[index]);
    showCurrentNumber();
    scheduleDraw();
  }

  /** Marks every block on the overview ruler where it sits in the right pane, which the view scrolls by. */
  function drawOverview() {
    overview.drawMarks(data.blocks.map((block, index) => ({
      top: lineTop("result", block.result[0]),
      bottom: lineTop("result", block.result[1]),
      kind: block.kind,
      isCurrent: index === currentIndex,
    })));
  }

  function isMarkedInView() {
    if (currentIndex === -1) {
      return false;
    }
    const scroller = scrollers.result;
    const [start, end] = data.blocks[currentIndex].result.map((line) => lineTop("result", line) - scroller.scrollTop);
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
      marker.style.top = markerLength(side, 0, start);
      marker.style.height = markerLength(side, start, end);
      marker.classList.toggle("is-empty", isEmpty);
      marker.classList.toggle("at-top", isEmpty && start === 0);
      marker.classList.toggle("at-bottom", isEmpty && start === lineCount);
      fitMarker(side);
      marker.hidden = false;
    }
  }

  /**
   * The CSS length of lines [start, end): in --row-height units while rows are uniform, which follow font and zoom
   * changes without measuring; in pixels while lines wrap.
   */
  function markerLength(side, start, end) {
    return wrappedOffsets === null
      ? `calc(${end - start} * var(--row-height))`
      : `${lineTop(side, end) - lineTop(side, start)}px`;
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

  /** The checkbox: turns wrapping on or off, keeping the right pane's top line in place, and remembers the choice. */
  function setWrapping(isOn) {
    const topLine = lineAt("result", scrollers.result.scrollTop);
    applyWrapping(isOn);
    showFromLine(topLine);
    saveState();
  }

  function applyWrapping(isOn) {
    isWrapping = isOn;
    wrapToggle.checked = isOn;
    diffElement.classList.toggle("is-wrapping", isOn);
    layOutRows();
  }

  /** Measures the rows again: one line height while lines run on, each row's height while they wrap. */
  function layOutRows() {
    for (const row of leveledRows) {
      row.style.minHeight = "";
    }
    leveledRows = [];
    if (!isWrapping) {
      wrappedOffsets = null;
      pixelAnchors = null;
      lineHeight = measureLineHeight();
      return;
    }
    wrappedOffsets = levelWrappedRows();
    // In pixels, the anchors map wrapped rows of different heights too.
    pixelAnchors = anchors.map((anchor) => ({ base: lineTop("base", anchor.base), result: lineTop("result", anchor.result) }));
  }

  /**
   * Gives corresponding rows the taller one's height and returns each side's row offsets. Every row is read before
   * any is written, so the page lays out once for the reads.
   */
  function levelWrappedRows() {
    measuredWidths = paneWidths();
    const rows = {};
    const naturalHeights = {};
    for (const side of SIDES) {
      rows[side] = Array.from(scrollers[side].querySelectorAll(".line"));
      naturalHeights[side] = rows[side].map((row) => row.getBoundingClientRect().height);
    }
    const heights = alignedRowHeights(anchors, naturalHeights);
    for (const side of SIDES) {
      rows[side].forEach((row, line) => {
        if (heights[side][line] > naturalHeights[side][line]) {
          row.style.minHeight = `${heights[side][line]}px`;
          leveledRows.push(row);
        }
      });
    }
    return { base: rowOffsets(heights.base), result: rowOffsets(heights.result) };
  }

  /** Both panes' widths, which decide where lines wrap. */
  function paneWidths() {
    return `${scrollers.base.clientWidth},${scrollers.result.clientWidth}`;
  }

  /** After a layout: scrolls the right pane to `topLine` and the left one with it, and redraws the marker and ribbons. */
  function showFromLine(topLine) {
    scrollers.result.scrollTop = lineTop("result", topLine);
    syncFrom("result");
    for (const side of SIDES) {
      fitMarker(side);
    }
    if (currentIndex !== -1) {
      markCurrent(data.blocks[currentIndex]);
    }
    drawOverview();
    scheduleDraw();
  }

  for (const side of SIDES) {
    scrollers[side].addEventListener("scroll", () => onScroll(side), { passive: true });
  }
  window.addEventListener("resize", () => {
    if (isWrapping) {
      scheduleWrappedResize();
      return;
    }
    lineHeight = measureLineHeight();
    fitView();
  });

  function fitView() {
    for (const side of SIDES) {
      fitMarker(side);
    }
    syncFrom("result");
    drawOverview();
    scheduleDraw();
  }

  /**
   * Dragging a sash fires resize continuously, so the wrapped rows are laid out at most once a frame, and only when the
   * panes' width changed, the one change that reflows them.
   */
  function scheduleWrappedResize() {
    if (isResizeScheduled) {
      return;
    }
    isResizeScheduled = true;
    requestAnimationFrame(() => {
      isResizeScheduled = false;
      if (!isWrapping) {
        return;
      }
      if (paneWidths() === measuredWidths) {
        fitView();
        return;
      }
      // The old offsets say which line the unchanged scroll offset showed at the top before the rows reflowed.
      const topLine = lineAt("result", scrollers.result.scrollTop);
      layOutRows();
      showFromLine(topLine);
    });
  }
  // The buttons stay within the file; a click ends any offer of the next or previous file.
  document.getElementById("prev").addEventListener("click", () => {
    endFileStepOffer();
    navigate(-1);
  });
  document.getElementById("next").addEventListener("click", () => {
    endFileStepOffer();
    navigate(1);
  });
  document.getElementById("open-native").addEventListener("click", () => post({ type: "openNative" }));
  wrapToggle.addEventListener("change", () => setWrapping(wrapToggle.checked));
  window.addEventListener("message", (event) => {
    const answer = fileStepAnswerOf(event.data);
    if (answer === null || fileList === null) {
      return;
    }
    if (answer.type === "noAdjacentFile") {
      onNoAdjacentFile(answer.direction);
      return;
    }
    const isOpeningTowards = fileStep !== null && fileStep.isOpening && fileStep.direction === answer.direction;
    if (isOpeningTowards) {
      endFileStep();
    }
  });

  /**
   * The host's answer to this page's file step, `noAdjacentFile` or `fileStepEnded`, with its direction as 1 or -1; null
   * for any other message.
   */
  function fileStepAnswerOf(message) {
    const isAnswer = typeof message === "object" && message !== null && message.page === page
      && (message.type === "noAdjacentFile" || message.type === "fileStepEnded")
      && (message.direction === "next" || message.direction === "previous");
    return isAnswer ? { type: message.type, direction: message.direction === "next" ? 1 : -1 } : null;
  }

  /**
   * A step that found no file to open that way, such as past files too large to show, leaves none there to offer. Says
   * so unless a hint for the other direction shows since the step began.
   */
  function onNoAdjacentFile(direction) {
    fileList = direction > 0 ? { ...fileList, hasNext: false } : { ...fileList, hasPrevious: false };
    const isOtherHintShown = fileStep !== null && fileStep.direction !== direction;
    if (!isOtherHintShown) {
      offerFileStep(direction);
    }
  }
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
  // Wrapping applies to every file the tab shows; the scroll offsets only to the same comparison.
  if (saved && saved.isWrapping === true) {
    applyWrapping(true);
  }
  if (saved && saved.key === scrollStateKey) {
    restoreScroll(saved);
    // A restored view marks no change.
    showCurrentNumber();
  } else if (data.blocks.length > 0) {
    goTo(diffElement.dataset.startAt === "last" ? data.blocks.length - 1 : 0);
  }
  drawOverview();
  scheduleDraw();
  post({ type: "ready" });
})();
