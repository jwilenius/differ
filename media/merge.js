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
  const merge = document.getElementById("merge");
  /** Stamped on every message, so the host can drop those this page sends after it was replaced. */
  const page = Number(merge.dataset.page);
  /** Replaced by the host's layout after the client splits or joins result lines. */
  let data = JSON.parse(merge.dataset.merge);
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
  /** The result lines a paste shortcut found selected, which the paste it brings replaces. */
  let pendingPaste = null;
  /** Numbers the splits and joins sent, so only the layout answering the latest one is drawn. */
  let layoutSeq = 0;
  /** The numbered edits the host's highlighting may not include yet: `{ seq, line, removed, added }`. */
  let numberedEdits = [];
  /** An IME composition in the result; re-highlighting its line would end it. */
  let isComposing = false;
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
    send(message);
  }

  function send(message) {
    vscode.postMessage({ ...message, page });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) {
      return;
    }
    const message = actionOf(button);
    if (!message) {
      return;
    }
    post(message);
    // Cancel may be called off in a dialog; every other action redraws the page, or closes it once applied.
    if (message.type !== "cancel") {
      awaitRedraw();
    }
  });

  /**
   * Edits and actions on a page the host is replacing would be lost with it, or name lines and chunks the host
   * has changed: send the edit held back and take no more.
   */
  function awaitRedraw() {
    flushPendingEdit();
    scrollers.result.inert = true;
    for (const button of document.querySelectorAll("button")) {
      button.disabled = true;
    }
  }

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
  /**
   * Holds what changed the result since the page last ran a callback: inside the `input` of a browser undo, which
   * VS Code's menu runs from script, that is the undo itself. Records are otherwise dropped as they arrive.
   */
  const nativeChanges = new MutationObserver(() => undefined);
  nativeChanges.observe(resultLines, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });

  resultLines.addEventListener("input", (event) => {
    const cell = editableOf(event.target);
    if (!cell) {
      return;
    }
    // VS Code's Undo and Redo menu items run the browser's own undo, which fires no `beforeinput`, and reach
    // the result once this page has typing of its own to undo (else the history seed takes them). What the browser
    // changed is put back: its undo knows nothing of the lines this page splits and joins, so it may take back
    // more or other than the merge's step, and the page shows what the host has until the host redraws it.
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      revertChanges(nativeChanges.takeRecords());
      stepHistory(event.inputType === "historyUndo" ? "undo" : "redo");
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

    // Over a selection across lines, Enter is typed over it, as any text is.
    if (event.key === "Enter" && !isSelectionAcrossLines()) {
      event.preventDefault();
      const selected = isSelectionEmpty() ? null : selectedLines();
      if (selected) {
        // The line break takes the place of the text selected within the line, in the same one edit.
        insertLines(selected, "\n");
      } else {
        editLines({ type: "splitLine", line, offset }, () => splitCell(cell, offset), line + 1, 0);
      }
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
    const isVerticalArrow = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (!isVerticalArrow || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const step = event.key === "ArrowUp" ? -1 : 1;
    // The browser extends a selection only within the line's own editable.
    if (event.shiftKey) {
      event.preventDefault();
      extendSelection(step);
      return;
    }
    const target = neighbourEditable(cell, step);
    if (target) {
      event.preventDefault();
      flushPendingEdit();
      placeCaret(target, Math.min(offset, target.textContent.length));
    }
  });

  // A selection across result lines spans their separate editables, which the browser edits none of: what is typed
  // over it replaces it here, as one edit. The key reaches the document when the selection was dragged from the
  // line numbers, which leaves no line focused. A key on any other element, such as a button the selection
  // outlived a click on, belongs to that element.
  document.addEventListener("keydown", (event) => {
    const isForResult = !event.isComposing && !resultLines.inert && isResultKeyTarget(event.target);
    const selected = isForResult ? selectedLines() : null;
    const text = selected && selected.first !== selected.last ? textTypedOver(event) : null;
    if (text === null) {
      return;
    }
    event.preventDefault();
    insertLines(selected, text);
  });

  /** Whether a key goes to the result: pressed in one of its lines, or with no element focused. */
  function isResultKeyTarget(target) {
    const cell = editableOf(target);
    return target === document.body || (cell !== null && resultLines.contains(cell));
  }

  /** The text a key types over a selection: a line break, none for a removal, or its character; null for other keys. */
  function textTypedOver(event) {
    if (event.key === "Enter") {
      return "\n";
    }
    // Shift+Delete cuts, which the browser turns into a `cut` event.
    const isRemoval = event.key === "Backspace" || (event.key === "Delete" && !event.shiftKey);
    if (isRemoval) {
      return "";
    }
    // Ctrl+Alt is AltGr, which types characters on Windows.
    const isShortcut = event.metaKey || (event.ctrlKey && !event.altKey);
    const isCharacter = Array.from(event.key).length === 1;
    return isCharacter && !isShortcut ? event.key : null;
  }

  // A line break typed any other way would put two lines into one cell. The browser's own undo knows nothing
  // of the lines this page splits, joins and colours, so an undo it is asked for goes to the host's history.
  resultLines.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
      event.preventDefault();
    } else if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      stepHistory(event.inputType === "historyUndo" ? "undo" : "redo");
    } else if (event.inputType === "insertText" && event.data && isSelectionAcrossLines()) {
      // Text that came without a key the page took, as from an on-screen keyboard.
      event.preventDefault();
      insertLines(selectedLines(), event.data);
    }
  });

  document.addEventListener("keydown", (event) => {
    const step = event.isComposing ? null : historyStepOf(event);
    if (!step) {
      return;
    }
    event.preventDefault();
    // VS Code would otherwise run its undo command on the webview too, undoing natively as well.
    event.stopPropagation();
    stepHistory(step);
  });

  /** Undo and redo replace the page, as resolving actions do. */
  function stepHistory(step) {
    post({ type: step });
    awaitRedraw();
  }

  /**
   * The page an undo or redo drew puts the caret where the step changed the result, and one a colour theme change
   * drew puts it where the page it replaced had it, so typing can go on.
   */
  function placeStepCaret() {
    const { caretLine, caretColumn } = merge.dataset;
    const cells = resultLines.querySelectorAll(".code[data-line]");
    if (caretLine === undefined || cells.length === 0) {
      return;
    }
    const cell = cells[Math.min(Number(caretLine), cells.length - 1)];
    placeCaret(cell, Number(caretColumn));
    cell.scrollIntoView({ block: "nearest" });
  }

  // VS Code's Undo and Redo menu items run the browser's own undo and redo, which do nothing while the browser
  // has no step to take back or put back, as on a freshly drawn page. A hidden editable gets one of each, which
  // the page never sends: the browser taking either routes the step to the merge's history.
  const historySeed = document.createElement("span");
  let isSeeding = false;

  function seedBrowserHistory() {
    historySeed.className = "history-seed";
    historySeed.setAttribute("contenteditable", "plaintext-only");
    historySeed.setAttribute("aria-hidden", "true");
    historySeed.tabIndex = -1;
    document.body.append(historySeed);
    historySeed.addEventListener("input", (event) => {
      if (!isSeeding && (event.inputType === "historyUndo" || event.inputType === "historyRedo")) {
        stepHistory(event.inputType === "historyUndo" ? "undo" : "redo");
      }
    });
    const selection = window.getSelection();
    isSeeding = true;
    for (const step of ["a", "b"]) {
      selection.selectAllChildren(historySeed);
      selection.collapseToEnd();
      document.execCommand("insertText", false, step);
    }
    document.execCommand("undo");
    isSeeding = false;
    selection.removeAllRanges();
    if (document.activeElement === historySeed) {
      historySeed.blur();
    }
  }

  /** "undo" or "redo" for their shortcuts, else null: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y. */
  function historyStepOf(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return null;
    }
    if (event.keyCode === 90) {
      return event.shiftKey ? "redo" : "undo";
    }
    return event.keyCode === 89 && !event.shiftKey ? "redo" : null;
  }

  // A selection spanning result lines (dragged from the line numbers) is not editable, so Chrome
  // pastes nothing into it: the caret moves into its first line so the paste lands there, and
  // the paste handler replaces the lines the selection covered.
  document.addEventListener("keydown", (event) => {
    const selected = isPasteKey(event) ? selectedLines() : null;
    pendingPaste = selected && selected.first !== selected.last ? selected : null;
    if (pendingPaste) {
      placeCaret(pendingPaste.first, pendingPaste.start);
    }
  });
  document.addEventListener("mousedown", () => {
    pendingPaste = null;
  });

  // Pasted or dropped text with line breaks becomes result lines; native handling would put the breaks inside one cell.
  resultLines.addEventListener("paste", (event) => {
    const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
    const selected = pendingPaste ?? selectedLines();
    pendingPaste = null;
    if (!selected || text === "" || (selected.first === selected.last && !hasLineBreak(text))) {
      return;
    }
    event.preventDefault();
    insertLines(selected, text);
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
      insertLines({ first: cell, start: offset, last: cell, end: offset }, text);
    }
  });

  // A selection across result lines starts in the line numbers and is not editable, so dropping it
  // would copy it, line numbers included, instead of moving it. Drags within one line move natively.
  resultLines.addEventListener("dragstart", (event) => {
    const selected = selectedLines();
    if (selected && selected.first !== selected.last) {
      event.preventDefault();
    }
  });

  // A selection across lines takes in their line numbers and gutter buttons, which a copy must leave out.
  document.addEventListener("copy", (event) => {
    const text = selectedCode();
    if (text !== null && event.clipboardData) {
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
    }
  });

  // The browser cuts nothing from a selection across result lines: the page copies it as above and removes it, as one edit.
  document.addEventListener("cut", (event) => {
    if (resultLines.inert || !isSelectionAcrossLines() || !event.clipboardData) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectedCode());
    insertLines(selectedLines(), "");
  });

  resultLines.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  resultLines.addEventListener("compositionend", () => {
    isComposing = false;
  });

  // Losing focus must not lose the keystrokes still sitting in the debounce.
  resultLines.addEventListener("focusout", flushPendingEdit, true);

  /** Takes back DOM changes, latest first. */
  function revertChanges(records) {
    for (const record of records.reverse()) {
      if (record.type === "characterData") {
        record.target.data = record.oldValue;
        continue;
      }
      record.addedNodes.forEach((node) => node.remove());
      record.removedNodes.forEach((node) => record.target.insertBefore(node, record.nextSibling));
    }
  }

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
    send(message);
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
    numberedEdits.push({ seq: layoutSeq, ...editedLines(message) });
    send({ ...message, seq: layoutSeq });
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

  function isPasteKey(event) {
    const isInsert = event.shiftKey && event.keyCode === 45;
    return isInsert || ((event.ctrlKey || event.metaKey) && !event.altKey && event.keyCode === 86);
  }

  /** Puts `text` in place of the selected result text, from `start` in cell `first` to `end` in cell `last`, as result lines. */
  function insertLines(selected, text) {
    const { first, start, last, end } = selected;
    const after = last.textContent.slice(end);
    const lines = pastedLines(first.textContent.slice(0, start), text, after);
    const line = Number(first.dataset.line);
    const count = Number(last.dataset.line) - line + 1;
    const caretLine = line + lines.length - 1;
    const caretColumn = lines[lines.length - 1].length - after.length;
    editLines({ type: "replaceLines", line, count, lines }, () => fillCells(first, last, lines), caretLine, caretColumn);
  }

  /** Gives cell `first` the first of `lines`, drops the lines after it through cell `last`, and adds the rest of `lines` below. */
  function fillCells(first, last, lines) {
    const line = first.parentElement;
    const dropped = resultLineElements().slice(Number(first.dataset.line) + 1, Number(last.dataset.line) + 1);
    dropped.forEach((element) => element.remove());
    first.textContent = lines[0];
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

  /**
   * Colours result lines again after the host highlighted the edited result. Each line follows the edits
   * numbered since, and keeps its markup when its text changed meanwhile: a later update brings that.
   */
  function applyHighlight(update) {
    numberedEdits = numberedEdits.filter((edit) => edit.seq > update.seq);
    document.getElementById("result-styles").textContent = update.styles;
    const cells = resultLines.querySelectorAll(".code[data-line]");
    for (const { line, text, html } of update.lines) {
      const target = lineAfterEdits(numberedEdits, line);
      const cell = target === null ? undefined : cells[target];
      const isComposingIn = isComposing && cell === document.activeElement;
      if (cell && cell.textContent === text && !isComposingIn) {
        setMarkup(cell, html);
      }
    }
  }

  /** Replaces a cell's markup, keeping the caret or selection in it. */
  function setMarkup(cell, html) {
    const selection = window.getSelection();
    const isSelectedIn = selection && selection.rangeCount > 0 && cell.contains(selection.anchorNode) && cell.contains(selection.focusNode);
    const anchor = isSelectedIn ? textOffset(cell, selection.anchorNode, selection.anchorOffset) : 0;
    const focus = isSelectedIn ? textOffset(cell, selection.focusNode, selection.focusOffset) : 0;
    cell.innerHTML = html;
    if (isSelectedIn) {
      const from = textPosition(cell, anchor);
      const to = textPosition(cell, focus);
      selection.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
    }
  }

  window.addEventListener("message", (event) => {
    const update = event.data;
    // A message for the page this one replaced can arrive after it loads.
    if (!update || update.page !== page) {
      return;
    }
    if (update.type === "redrawing") {
      // Sent after the held-back edit, so the host draws the new page with it; the caret is taken before
      // the result turns inert and loses it.
      const caret = resultCaret();
      awaitRedraw();
      send({ type: "redrawReady", caret });
    } else if (update.type === "layout" && update.seq === layoutSeq) {
      applyLayout(update.data);
    } else if (update.type === "highlight") {
      applyHighlight(update);
    }
  });

  function neighbourEditable(cell, step) {
    const cells = Array.from(resultLines.querySelectorAll(".code[data-line]"));
    return cells[cells.indexOf(cell) + step] ?? null;
  }

  /** Where the caret is in the result while the page has focus, for the page that replaces this one to put back; else null. */
  function resultCaret() {
    const cell = editableOf(document.activeElement);
    if (!document.hasFocus() || !cell || !resultLines.contains(cell)) {
      return null;
    }
    return { line: Number(cell.dataset.line), column: caretOffset(cell) };
  }

  function caretOffset(cell) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return 0;
    }
    const caret = selection.getRangeAt(0);
    return textOffset(cell, caret.endContainer, caret.endOffset);
  }

  /**
   * The result text the selection covers: the cells of its first and last lines and its character
   * offsets in them; null unless both of its ends lie in result lines.
   */
  function selectedLines() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const first = cellOfLine(range.startContainer);
    const last = cellOfLine(range.endContainer);
    if (!first || !last) {
      return null;
    }
    return {
      first,
      start: offsetIn(first, range.startContainer, range.startOffset),
      last,
      end: offsetIn(last, range.endContainer, range.endOffset),
    };
  }

  /** The code text of the lines a selection across lines of one pane covers, one per line; null for any other selection. */
  function selectedCode() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const first = lineOf(range.startContainer);
    const last = lineOf(range.endContainer);
    if (!first || !last || first === last || first.parentElement !== last.parentElement) {
      return null;
    }
    const lines = Array.from(first.parentElement.querySelectorAll(".line"));
    const covered = lines.slice(lines.indexOf(first), lines.indexOf(last) + 1).map((line) => line.querySelector(".code"));
    const start = offsetIn(covered[0], range.startContainer, range.startOffset);
    const end = offsetIn(covered[covered.length - 1], range.endContainer, range.endOffset);
    const texts = covered.map((code) => code.textContent);
    texts[texts.length - 1] = texts[texts.length - 1].slice(0, end);
    texts[0] = texts[0].slice(start);
    return texts.join("\n");
  }

  function lineOf(node) {
    const element = node instanceof Element ? node : node.parentElement;
    return element ? element.closest(".line") : null;
  }

  /** The editable cell of the result line holding a node, its line number included. */
  function cellOfLine(node) {
    const element = node instanceof Element ? node : node.parentElement;
    const line = element && resultLines.contains(element) ? element.closest(".line") : null;
    return line ? line.querySelector(".code[data-line]") : null;
  }

  /** How many characters of a cell come before a DOM position: none when it lies before the cell, all when after. */
  function offsetIn(cell, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(cell);
    const side = range.comparePoint(node, offset);
    return side < 0 ? 0 : side > 0 ? cell.textContent.length : textOffset(cell, node, offset);
  }

  /** How many characters of a cell come before a DOM position inside it. */
  function textOffset(cell, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  /** Whether the selection runs from one result line into another. */
  function isSelectionAcrossLines() {
    const selected = selectedLines();
    return selected !== null && selected.first !== selected.last;
  }

  /** Moves the selection's end to the line above or below at its column; on the first or last line, to its start or end. */
  function extendSelection(step) {
    const selection = window.getSelection();
    const focusCell = cellOfLine(selection.focusNode);
    if (!focusCell) {
      return;
    }
    const target = neighbourEditable(focusCell, step);
    const lineEnd = step < 0 ? 0 : focusCell.textContent.length;
    const column = target ? offsetIn(focusCell, selection.focusNode, selection.focusOffset) : lineEnd;
    const position = textPosition(target ?? focusCell, column);
    selection.extend(position.node, position.offset);
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
  seedBrowserHistory();
  placeStepCaret();

  scheduleDraw();
})();
