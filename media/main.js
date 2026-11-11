(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const grid = document.getElementById("grid");
  const EDIT_DEBOUNCE_MS = 400;

  let focusedConflict = -1;
  let pendingEdit = null;
  let pendingTimer = null;

  // --- resolution actions ---

  grid.addEventListener("click", (event) => {
    const button = event.target.closest("button.resolve");
    if (!button) {
      return;
    }
    flushPendingEdit();
    hideMenus();
    markPending(button.dataset.conflict);
    vscode.postMessage({
      type: "resolve",
      conflictIndex: Number(button.dataset.conflict),
      resolution: button.dataset.resolution,
    });
  });

  // --- partial resolution: include one side of one hunk ---

  grid.addEventListener("click", (event) => {
    const box = event.target.closest("button.hunk-box");
    if (!box) {
      return;
    }
    flushPendingEdit();

    // Tick straight away; the rebuild that follows confirms it.
    const isIncluded = !box.classList.contains("included");
    box.classList.toggle("included", isIncluded);
    box.setAttribute("aria-checked", String(isIncluded));
    box.textContent = isIncluded ? "☑" : "☐";

    vscode.postMessage({
      type: "toggleHunk",
      conflictIndex: Number(box.dataset.conflict),
      hunkIndex: Number(box.dataset.hunk),
      side: box.dataset.side,
    });
  });

  grid.addEventListener("click", (event) => {
    const button = event.target.closest("button.apply-selection");
    if (!button) {
      return;
    }
    flushPendingEdit();
    hideMenus();
    markPending(button.dataset.conflict);
    vscode.postMessage({ type: "applySelection", conflictIndex: Number(button.dataset.conflict) });
  });

  function markPending(conflictIndex) {
    for (const row of document.querySelectorAll(`.row[data-conflict="${conflictIndex}"]`)) {
      row.classList.add("pending");
    }
  }

  // --- per-conflict menu, opened by right-clicking anywhere in the conflict ---

  grid.addEventListener("contextmenu", (event) => {
    // Editing and copying keep the browser's own Cut/Copy/Paste menu.
    const isEditingOrCopying = event.target.closest(".editable") || !isSelectionEmpty();
    if (isEditingOrCopying) {
      return;
    }

    const row = event.target.closest(".row[data-conflict]");
    const menu = row && document.querySelector(`.context-menu[data-menu="${row.dataset.conflict}"]`);
    if (!menu) {
      return;
    }
    event.preventDefault();
    hideMenus();

    menu.hidden = false;
    const left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 4);
    const top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 4);
    menu.style.left = `${Math.max(0, left)}px`;
    menu.style.top = `${Math.max(0, top)}px`;
    menu.querySelector("button")?.focus();
  });

  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest(".context-menu")) {
      hideMenus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideMenus();
    }
  });

  window.addEventListener("scroll", hideMenus);

  function hideMenus() {
    for (const menu of document.querySelectorAll(".context-menu:not([hidden])")) {
      menu.hidden = true;
    }
  }

  // --- editing the working copy ---

  grid.addEventListener("input", (event) => {
    const cell = event.target.closest(".editable");
    if (!cell) {
      return;
    }

    const line = Number(cell.dataset.line);
    pendingEdit = { type: "editLine", line, text: cell.textContent, focus: { line, offset: caretOffset(cell) } };
    schedulePendingEdit();
  });

  grid.addEventListener("keydown", (event) => {
    const cell = event.target.closest(".editable");
    if (!cell) {
      return;
    }

    const line = Number(cell.dataset.line);
    const offset = caretOffset(cell);

    if (event.key === "Enter") {
      event.preventDefault();
      sendNow({ type: "splitLine", line, offset, focus: { line: line + 1, offset: 0 } });
      return;
    }

    // Backspace at column zero joins onto the line above, as in a normal editor.
    if (event.key === "Backspace" && offset === 0 && isSelectionEmpty()) {
      event.preventDefault();
      const previous = previousEditable(cell);
      if (previous) {
        const focus = { line: Number(previous.dataset.line), offset: previous.textContent.length };
        sendNow({ type: "joinWithPrevious", line, focus });
      }
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const target = event.key === "ArrowUp" ? previousEditable(cell) : nextEditable(cell);
      if (target) {
        event.preventDefault();
        flushPendingEdit();
        placeCaret(target, Math.min(offset, target.textContent.length));
      }
    }
  });

  // Losing focus must not lose the keystrokes still sitting in the debounce.
  grid.addEventListener("focusout", (event) => {
    if (event.target.closest(".editable")) {
      flushPendingEdit();
    }
  }, true);

  function schedulePendingEdit() {
    window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(flushPendingEdit, EDIT_DEBOUNCE_MS);
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

  /** Structural edits renumber lines, so they cannot sit behind a debounce. */
  function sendNow(message) {
    flushPendingEdit();
    vscode.postMessage(message);
  }

  // --- caret helpers ---

  function caretOffset(cell) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return 0;
    }
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(cell);
    range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
    return range.toString().length;
  }

  function isSelectionEmpty() {
    const selection = window.getSelection();
    return !selection || selection.isCollapsed;
  }

  function placeCaret(cell, offset) {
    cell.focus();
    const textNode = cell.querySelector(".code")?.firstChild ?? cell.firstChild;
    if (!textNode) {
      return;
    }

    const range = document.createRange();
    const clamped = Math.min(offset, textNode.textContent.length);
    range.setStart(textNode, clamped);
    range.collapse(true);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function previousEditable(cell) {
    const cells = editableCells();
    return cells[cells.indexOf(cell) - 1] ?? null;
  }

  function nextEditable(cell) {
    const cells = editableCells();
    return cells[cells.indexOf(cell) + 1] ?? null;
  }

  function editableCells() {
    return Array.from(document.querySelectorAll(".editable"));
  }

  // --- conflict navigation ---

  document.getElementById("next").addEventListener("click", () => moveToConflict(1));
  document.getElementById("prev").addEventListener("click", () => moveToConflict(-1));

  document.addEventListener("keydown", (event) => {
    const isNext = event.key === "F7" && !event.shiftKey;
    const isPrevious = event.key === "F7" && event.shiftKey;

    if (isNext || isPrevious) {
      event.preventDefault();
      moveToConflict(isNext ? 1 : -1);
    }
  });

  function moveToConflict(step) {
    const bars = Array.from(document.querySelectorAll(".row.conflict-start > .cell.pane-ours"));
    if (bars.length === 0) {
      return;
    }

    const count = bars.length;
    const from = focusedConflict === -1 && step < 0 ? 0 : focusedConflict;
    focusedConflict = (from + step + count) % count;
    bars[focusedConflict].scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // --- restore state after a rebuild ---

  const focusLine = document.body.dataset.focusLine;
  if (focusLine !== undefined) {
    const cell = document.querySelector(`.editable[data-line="${focusLine}"]`);
    if (cell) {
      placeCaret(cell, Number(document.body.dataset.focusOffset ?? 0));
    }
  }

  const state = vscode.getState();
  if (state && typeof state.scrollY === "number") {
    window.scrollTo(0, state.scrollY);
  }

  window.addEventListener("scroll", () => {
    vscode.setState({ scrollY: window.scrollY });
  });
})();
