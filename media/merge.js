// Three-way merge client. The geometry it uses comes from diffGeometry.js,
// which the page loads first; this wiring runs only inside a webview.
//
// The result pane leads: the side panes follow it through anchors built from
// the chunks, and scrolling a side moves the result, which moves the other side.

(function () {
  "use strict";

  if (typeof acquireVsCodeApi !== "function") {
    return;
  }

  /** Fraction of the viewport above a chunk navigated to. */
  const NAVIGATION_OFFSET = 0.25;
  const EDIT_DEBOUNCE_MS = 400;
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const PANES = ["left", "result", "right"];
  const SIDES = ["left", "right"];

  const vscode = acquireVsCodeApi();
  /** Replaced by the host's layout after the client splits or joins result lines. */
  let data = JSON.parse(document.getElementById("merge").dataset.merge);
  const lineCounts = { left: data.leftLineCount, result: data.resultLineCount, right: data.rightLineCount };
  const anchors = {
    left: buildAnchors(blocksOf("left"), lineCounts.left, lineCounts.result),
    right: buildAnchors(blocksOf("right"), lineCounts.right, lineCounts.result),
  };
  let unresolved = data.chunks.filter((chunk) => !chunk.isResolved);
  const scrollers = {
    left: document.getElementById("scroll-left"),
    result: document.getElementById("scroll-result"),
    right: document.getElementById("scroll-right"),
  };
  const strips = { left: document.getElementById("connectors-left"), right: document.getElementById("connectors-right") };

  /** Offsets this script set and must not echo back. */
  const expectedTop = { left: null, result: null, right: null };
  /** Vertical offsets last seen, so horizontal scrolling never moves another pane. */
  const lastTop = { left: 0, result: 0, right: 0 };
  let lineHeight = measureLineHeight();
  let isDrawScheduled = false;
  let navigation = { index: -1, top: -1 };
  let pendingEdit = null;
  let pendingTimer = null;
  /** Numbers the splits and joins sent, so only the layout answering the latest one is drawn. */
  let layoutSeq = 0;
  /** The page is rebuilt after every action; the panel title tells one merge from another. */
  const scrollStateKey = document.title;

  /** Chunks as `diffGeometry` blocks: `base` is the side, `result` the result. */
  function blocksOf(side) {
    return data.chunks.map((chunk) => ({ base: chunk[side], result: chunk.result }));
  }

  function measureLineHeight() {
    const line = document.querySelector(".line");
    return line ? line.getBoundingClientRect().height || 1 : 1;
  }

  function viewport(scroller) {
    return {
      top: scroller.scrollTop,
      height: scroller.clientHeight,
      max: Math.max(scroller.scrollHeight - scroller.clientHeight, 0),
    };
  }

  // --- scrolling ---

  function onScroll(pane) {
    saveScroll();
    const top = scrollers[pane].scrollTop;
    const expected = expectedTop[pane];
    expectedTop[pane] = null;
    scheduleDraw();
    if (Math.abs(top - lastTop[pane]) < 1) {
      return;
    }
    lastTop[pane] = top;
    if (expected !== null && Math.abs(top - expected) < 1) {
      return;
    }
    syncFrom(pane);
  }

  function syncFrom(pane) {
    if (pane !== "result") {
      follow("result", syncedScrollTop(anchors[pane], "base", "result", viewport(scrollers[pane]), viewport(scrollers.result), lineHeight));
    }
    for (const side of SIDES) {
      if (side !== pane) {
        follow(side, syncedScrollTop(anchors[side], "result", "base", viewport(scrollers.result), viewport(scrollers[side]), lineHeight));
      }
    }
  }

  function follow(pane, top) {
    const scroller = scrollers[pane];
    if (Math.abs(scroller.scrollTop - top) < 1) {
      return;
    }
    scroller.scrollTop = top;
    // Read back: the browser may round or clamp, and an unchanged offset fires no event.
    expectedTop[pane] = scroller.scrollTop;
    lastTop[pane] = scroller.scrollTop;
  }

  function saveScroll() {
    vscode.setState({
      key: scrollStateKey,
      left: scrollers.left.scrollTop,
      result: scrollers.result.scrollTop,
      right: scrollers.right.scrollTop,
    });
  }

  function restoreScroll(saved) {
    for (const pane of PANES) {
      scrollers[pane].scrollTop = saved[pane];
      lastTop[pane] = scrollers[pane].scrollTop;
      // Only a moved pane fires a scroll event that consumes the expectation.
      expectedTop[pane] = scrollers[pane].scrollTop > 0 ? scrollers[pane].scrollTop : null;
    }
  }

  // --- connectors ---

  function scheduleDraw() {
    if (isDrawScheduled) {
      return;
    }
    isDrawScheduled = true;
    requestAnimationFrame(() => {
      isDrawScheduled = false;
      drawConnectors("left");
      drawConnectors("right");
    });
  }

  /** A ribbon for every change the side still offers; the left strip runs side → result, the right result → side. */
  function drawConnectors(side) {
    const svg = strips[side];
    const width = svg.clientWidth;
    const height = svg.clientHeight;
    const sideTop = scrollers[side].scrollTop;
    const resultTop = scrollers.result.scrollTop;
    const pendingKey = side === "left" ? "isLeftPending" : "isRightPending";
    const paths = [];

    for (const chunk of data.chunks) {
      if (!chunk[pendingKey]) {
        continue;
      }
      const sideBand = [chunk[side][0] * lineHeight - sideTop, chunk[side][1] * lineHeight - sideTop];
      const resultBand = [chunk.result[0] * lineHeight - resultTop, chunk.result[1] * lineHeight - resultTop];
      const isVisible = isBandVisible(sideBand[0], sideBand[1], height) || isBandVisible(resultBand[0], resultBand[1], height);
      if (!isVisible) {
        continue;
      }
      const [leftBand, rightBand] = side === "left" ? [sideBand, resultBand] : [resultBand, sideBand];
      const path = document.createElementNS(SVG_NAMESPACE, "path");
      path.setAttribute("class", `conn conn-${chunk.tint}`);
      path.setAttribute("d", connectorPath(width, leftBand[0], leftBand[1], rightBand[0], rightBand[1]));
      paths.push(path);
    }
    svg.replaceChildren(...paths);
  }

  // --- navigation among unresolved chunks ---

  function navigate(direction) {
    const scroller = scrollers.result;
    const offset = scroller.clientHeight * NAVIGATION_OFFSET;
    const isStillAtLastTarget = navigation.index !== -1 && Math.abs(scroller.scrollTop - navigation.top) < 1;
    const first = isStillAtLastTarget
      ? navigation.index + direction
      : neighbourBlock(unresolved, "result", (scroller.scrollTop + offset) / lineHeight, direction);
    for (let index = first; index >= 0 && index < unresolved.length; index += direction) {
      if (goTo(index)) {
        return;
      }
    }
  }

  /** Scrolls unresolved chunk `index` into view near the top; returns whether the view moved. */
  function goTo(index) {
    const scroller = scrollers.result;
    const before = scroller.scrollTop;
    scroller.scrollTop = unresolved[index].result[0] * lineHeight - scroller.clientHeight * NAVIGATION_OFFSET;
    navigation = { index, top: scroller.scrollTop };
    return Math.abs(scroller.scrollTop - before) >= 1;
  }

  // --- actions ---

  function post(message) {
    flushPendingEdit();
    vscode.postMessage(message);
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) {
      return;
    }
    const message = actionOf(button);
    if (message) {
      post(message);
    }
  });

  function actionOf(button) {
    const { dataset } = button;
    if (button.classList.contains("act")) {
      const type = dataset.action === "apply" ? "applySide" : "ignoreSide";
      return { type, chunk: Number(dataset.chunk), side: dataset.side };
    }
    if (dataset.nonConflicting) {
      return { type: "applyNonConflicting", scope: dataset.nonConflicting };
    }
    if (dataset.accept) {
      return { type: "acceptSide", side: dataset.accept };
    }
    if (button.id === "apply" || button.id === "cancel") {
      return { type: button.id };
    }
    return null;
  }

  // --- editing the result ---

  const resultLines = scrollers.result;

  resultLines.addEventListener("input", (event) => {
    const cell = editableOf(event.target);
    if (!cell) {
      return;
    }
    const line = Number(cell.dataset.line);
    // One drag can change two lines; the first line's edit must not be overwritten.
    if (pendingEdit && pendingEdit.line !== line) {
      flushPendingEdit();
    }
    pendingEdit = { type: "editLine", line, text: cell.textContent };
    window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(flushPendingEdit, EDIT_DEBOUNCE_MS);
  });

  resultLines.addEventListener("keydown", (event) => {
    const cell = editableOf(event.target);
    // Keys that finish an IME composition belong to the composition.
    if (!cell || event.isComposing) {
      return;
    }
    const line = Number(cell.dataset.line);
    const offset = caretOffset(cell);

    if (event.key === "Enter") {
      event.preventDefault();
      editLines({ type: "splitLine", line, offset }, () => splitCell(cell, offset), line + 1, 0);
      return;
    }
    // Backspace at column zero joins onto the line above, as in a normal editor.
    if (event.key === "Backspace" && offset === 0 && isSelectionEmpty()) {
      event.preventDefault();
      const previous = neighbourEditable(cell, -1);
      if (previous) {
        const joinOffset = previous.textContent.length;
        editLines({ type: "joinWithPrevious", line }, () => joinCells(previous, cell), line - 1, joinOffset);
      }
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const target = neighbourEditable(cell, event.key === "ArrowUp" ? -1 : 1);
      if (target) {
        event.preventDefault();
        flushPendingEdit();
        placeCaret(target, Math.min(offset, target.textContent.length));
      }
    }
  });

  // A line break typed any other way would put two lines into one cell.
  resultLines.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
      event.preventDefault();
    }
  });

  // Pasted or dropped text with line breaks becomes result lines; native handling would put the breaks inside one cell.
  resultLines.addEventListener("paste", (event) => {
    const cell = editableOf(event.target);
    const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
    if (!cell || !hasLineBreak(text)) {
      return;
    }
    event.preventDefault();
    const selection = selectionOffsets(cell);
    if (selection) {
      insertLines(cell, selection.start, selection.end, text);
    }
  });

  resultLines.addEventListener("drop", (event) => {
    const text = event.dataTransfer ? event.dataTransfer.getData("text/plain") : "";
    if (!hasLineBreak(text)) {
      return;
    }
    event.preventDefault();
    const point = document.caretRangeFromPoint(event.clientX, event.clientY);
    const node = point ? point.startContainer : null;
    const cell = editableOf(node instanceof Text ? node.parentElement : node);
    if (cell && resultLines.contains(cell)) {
      const offset = textOffset(cell, point.startContainer, point.startOffset);
      insertLines(cell, offset, offset, text);
    }
  });

  // Losing focus must not lose the keystrokes still sitting in the debounce.
  resultLines.addEventListener("focusout", flushPendingEdit, true);

  function editableOf(target) {
    return target instanceof Element ? target.closest(".code[data-line]") : null;
  }

  function flushPendingEdit() {
    window.clearTimeout(pendingTimer);
    if (!pendingEdit) {
      return;
    }
    const message = pendingEdit;
    pendingEdit = null;
    vscode.postMessage(message);
  }

  /**
   * Changes result lines on the page itself, so typing goes on undisturbed, and
   * tells the host, whose layout answer then redraws tints and ribbons.
   */
  function editLines(message, changeCells, caretLine, caretColumn) {
    flushPendingEdit();
    changeCells();
    renumberResultLines(message.line);
    placeCaret(resultLineElements()[caretLine].querySelector(".code"), caretColumn);
    layoutSeq += 1;
    vscode.postMessage({ ...message, seq: layoutSeq });
  }

  /** Moves the text after `offset` onto a new line below, keeping its highlighting. */
  function splitCell(cell, offset) {
    const line = cell.parentElement;
    if (offset >= cell.textContent.length) {
      line.after(createResultLine(line, ""));
      return;
    }
    const tail = document.createRange();
    tail.selectNodeContents(cell);
    const start = textPosition(cell, offset);
    tail.setStart(start.node, start.offset);
    line.after(createResultLine(line, tail.extractContents()));
  }

  function hasLineBreak(text) {
    return /[\r\n]/.test(text);
  }

  /** Puts `text`, which holds line breaks, in place of characters `start` to `end` of a cell, as result lines. */
  function insertLines(cell, start, end, text) {
    const current = cell.textContent;
    const after = current.slice(end);
    const lines = pastedLines(current.slice(0, start), text, after);
    const line = Number(cell.dataset.line);
    const last = lines.length - 1;
    editLines({ type: "replaceLine", line, lines }, () => fillCells(cell, lines), line + last, lines[last].length - after.length);
  }

  /** Gives a cell the first of `lines` and adds the rest as new lines below it. */
  function fillCells(cell, lines) {
    const line = cell.parentElement;
    cell.textContent = lines[0];
    line.after(...lines.slice(1).map((text) => createResultLine(line, text)));
  }

  function joinCells(previous, cell) {
    previous.append(...Array.from(cell.childNodes));
    cell.parentElement.remove();
  }

  /**
   * A result line as the host renders it, holding `content` (text or nodes); `renumberResultLines`
   * numbers it. It shares the tint of `neighbour` until the host's layout arrives.
   */
  function createResultLine(neighbour, content) {
    const line = document.createElement("div");
    line.className = Array.from(neighbour.classList).filter((name) => name === "line" || name.startsWith("chg-")).join(" ");
    const number = document.createElement("span");
    number.className = "num";
    const code = document.createElement("span");
    code.className = "code";
    code.setAttribute("contenteditable", "plaintext-only");
    code.setAttribute("spellcheck", "false");
    code.append(content);
    line.append(number, code);
    return line;
  }

  function resultLineElements() {
    return Array.from(resultLines.querySelectorAll(".line"));
  }

  function renumberResultLines(start) {
    const lines = resultLineElements();
    for (let index = start; index < lines.length; index++) {
      lines[index].querySelector(".num").textContent = String(index + 1);
      lines[index].querySelector(".code").dataset.line = String(index);
    }
  }

  /** Takes the host's chunk layout after lines were added or removed: tints, ribbons and scroll anchors follow the moved lines. */
  function applyLayout(layout) {
    data = layout;
    lineCounts.result = layout.resultLineCount;
    anchors.left = buildAnchors(blocksOf("left"), lineCounts.left, lineCounts.result);
    anchors.right = buildAnchors(blocksOf("right"), lineCounts.right, lineCounts.result);
    unresolved = data.chunks.filter((chunk) => !chunk.isResolved);
    const classes = resultLineClasses(data.chunks, lineCounts.result);
    resultLineElements().forEach((line, index) => {
      line.className = classes[index] ?? "line";
    });
    scheduleDraw();
  }

  window.addEventListener("message", (event) => {
    const update = event.data;
    const isLatestLayout = update && update.type === "layout" && update.seq === layoutSeq;
    if (isLatestLayout) {
      applyLayout(update.data);
    }
  });

  function neighbourEditable(cell, step) {
    const cells = Array.from(resultLines.querySelectorAll(".code[data-line]"));
    return cells[cells.indexOf(cell) + step] ?? null;
  }

  function caretOffset(cell) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return 0;
    }
    const caret = selection.getRangeAt(0);
    return textOffset(cell, caret.endContainer, caret.endOffset);
  }

  /** Where the selection starts and ends in a cell, in characters; null unless it lies within the cell. */
  function selectionOffsets(cell) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!cell.contains(range.startContainer) || !cell.contains(range.endContainer)) {
      return null;
    }
    return {
      start: textOffset(cell, range.startContainer, range.startOffset),
      end: textOffset(cell, range.endContainer, range.endOffset),
    };
  }

  /** How many characters of a cell come before a DOM position inside it. */
  function textOffset(cell, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  function isSelectionEmpty() {
    const selection = window.getSelection();
    return !selection || selection.isCollapsed;
  }

  function placeCaret(cell, offset) {
    cell.focus({ preventScroll: true });
    const position = textPosition(cell, offset);
    const range = document.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** The DOM position `offset` characters into a cell; its end when the cell is shorter. */
  function textPosition(cell, offset) {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, offset);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (remaining <= node.textContent.length) {
        return { node, offset: remaining };
      }
      remaining -= node.textContent.length;
    }
    return { node: cell, offset: cell.childNodes.length };
  }

  // --- wiring ---

  for (const pane of PANES) {
    scrollers[pane].addEventListener("scroll", () => onScroll(pane), { passive: true });
  }
  window.addEventListener("resize", () => {
    lineHeight = measureLineHeight();
    syncFrom("result");
    scheduleDraw();
  });
  document.getElementById("prev").addEventListener("click", () => navigate(-1));
  document.getElementById("next").addEventListener("click", () => navigate(1));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "F7") {
      return;
    }
    event.preventDefault();
    navigate(event.shiftKey ? -1 : 1);
  });

  for (const button of [document.getElementById("prev"), document.getElementById("next")]) {
    button.disabled = unresolved.length === 0;
  }
  const saved = vscode.getState();
  if (saved && saved.key === scrollStateKey) {
    restoreScroll(saved);
  } else if (unresolved.length > 0) {
    goTo(0);
    syncFrom("result");
  }

  scheduleDraw();
})();
