// History panel client. The host replaces the whole document on every
// publication, so this script runs once per published state: it reads that
// state from `body[data-history]`, restores focus/scroll/drafts saved with
// `setState`, and posts typed intents. Selection is computed by full OID,
// starting from the published state; the client never touches Git.
(function () {
  "use strict";

  const SEARCH_DEBOUNCE_MS = 150;
  /** Arrow keys move the focus at once; the host hears of it, and shows its details, once the user pauses. */
  const FOCUS_DEBOUNCE_MS = 250;
  const SCROLL_PANES = ["commit-pane", "detail-pane"];
  const SEARCH_ID = "history-search";
  const BASE_INPUT_ID = "history-base-input";
  const PIXEL_WIDTH_PATTERN = /^\d+(\.\d+)?px$/;

  const vscode = acquireVsCodeApi();
  const published = JSON.parse(document.body.dataset.history);
  const searchInput = document.getElementById(SEARCH_ID);

  /**
   * Presentation kept by the iframe across publications of one repository:
   * range anchor, last focused control, caret, pane scroll offsets and unsent
   * text or focus.
   */
  let view = restoreView();
  /**
   * Selection and focus as last sent: several gestures can be made before the
   * document showing the first one arrives, and each must build on the last.
   */
  let selection = published.selectedOids;
  let focusedOid = published.focusedOid;
  let searchTimer = null;
  let focusTimer = null;

  post("ready", {});
  restoreScroll();
  restoreDetailWidth();
  restoreSearchDraft();
  restoreFocusDraft();
  restoreFocus();

  // --- commit selection ---

  document.addEventListener("click", (event) => {
    const row = event.target.closest("tr.commit-row");
    if (!row) {
      return;
    }
    const oid = row.dataset.oid;
    const isToggle = isModifierPressed(event) && !event.shiftKey;
    if (isToggle) {
      postSelection(toggled(oid), oid, oid);
      return;
    }
    if (event.shiftKey) {
      selectRangeTo(oid, isModifierPressed(event));
      return;
    }
    postSelection([oid], oid, oid);
  });

  document.addEventListener("keydown", (event) => {
    const row = event.target.closest("tr.commit-row");
    if (!row) {
      return;
    }
    const oid = row.dataset.oid;
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      moveFocus(oid, step, event);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      postSelection(toggled(oid), oid, oid);
    }
  });

  function moveFocus(oid, step, event) {
    const rendered = published.renderedOids;
    const nextOid = rendered[rendered.indexOf(oid) + step];
    if (nextOid === undefined) {
      return;
    }
    // The range anchors at the focus before this move.
    if (event.shiftKey) {
      selectRangeTo(nextOid, isModifierPressed(event), oid);
      focusElement(rowFor(nextOid));
      return;
    }
    showFocus(nextOid);
    focusElement(rowFor(nextOid));
    saveView({ focusDraft: nextOid });
    scheduleFocus();
  }

  /** Shift range from the anchor over rendered rows; selections outside the rendered rows survive. */
  function selectRangeTo(oid, isUnion, fallbackAnchor) {
    const anchor = rangeAnchor(fallbackAnchor || oid);
    const range = renderedRange(anchor, oid);
    const kept = isUnion ? selection : unrenderedSelection();
    postSelection(union(kept, range), oid, anchor);
  }

  function postSelection(oids, focusOid, anchorOid) {
    saveView({ anchorOid });
    postSelect(oids, focusOid);
  }

  /** A selection carries the focus, so it also delivers any focus still waiting to be sent. */
  function postSelect(oids, focusOid) {
    cancelFocus();
    saveView({ focusDraft: null });
    selection = oids;
    showFocus(focusOid);
    post("select", { oids, focusedOid: focusOid });
  }

  /** First rendered of: last clicked/toggled row, current focus, `fallbackOid`. */
  function rangeAnchor(fallbackOid) {
    const rendered = published.renderedOids;
    const candidates = [view.anchorOid, focusedOid, fallbackOid];
    return candidates.find((oid) => oid && rendered.includes(oid)) || fallbackOid;
  }

  function renderedRange(fromOid, toOid) {
    const rendered = published.renderedOids;
    const from = rendered.indexOf(fromOid);
    const to = rendered.indexOf(toOid);
    return rendered.slice(Math.min(from, to), Math.max(from, to) + 1);
  }

  function unrenderedSelection() {
    const rendered = new Set(published.renderedOids);
    return selection.filter((oid) => !rendered.has(oid));
  }

  function toggled(oid) {
    return selection.includes(oid) ? selection.filter((other) => other !== oid) : [...selection, oid];
  }

  function union(first, second) {
    const seen = new Set(first);
    return [...first, ...second.filter((oid) => !seen.has(oid))];
  }

  function rowFor(oid) {
    return commitRows().find((row) => row.dataset.oid === oid);
  }

  function commitRows() {
    return [...document.querySelectorAll("tr.commit-row")];
  }

  /** Marks `oid`'s row as focused and gives it the tab stop, as the renderer would; unrendered focus changes no row. */
  function showFocus(oid) {
    focusedOid = oid;
    const rows = commitRows();
    if (!rows.some((row) => row.dataset.oid === oid)) {
      return;
    }
    for (const row of rows) {
      const isFocused = row.dataset.oid === oid;
      row.classList.toggle("is-focused", isFocused);
      row.setAttribute("tabindex", isFocused ? "0" : "-1");
      if (isFocused) {
        row.setAttribute("aria-current", "true");
      } else {
        row.removeAttribute("aria-current");
      }
    }
  }

  function scheduleFocus() {
    cancelFocus();
    focusTimer = setTimeout(() => sendPresentation({}), FOCUS_DEBOUNCE_MS);
  }

  function cancelFocus() {
    clearTimeout(focusTimer);
    focusTimer = null;
  }

  /** A focus not yet sent when this document replaced the last one is shown again and resent. */
  function restoreFocusDraft() {
    const draft = view.focusDraft;
    if (!draft) {
      return;
    }
    const isSettled = draft === published.focusedOid || !published.renderedOids.includes(draft);
    if (isSettled) {
      saveView({ focusDraft: null });
      return;
    }
    showFocus(draft);
    scheduleFocus();
  }

  // --- changed files: single click only focuses; double-click or Enter opens ---

  document.addEventListener("dblclick", (event) => {
    const file = event.target.closest("button.file-row");
    if (file) {
      openFile(file);
    }
  });

  document.addEventListener("keydown", (event) => {
    const file = event.target.closest("button.file-row");
    if (file && event.key === "Enter") {
      event.preventDefault();
      openFile(file);
    }
  });

  function openFile(file) {
    post("openFile", { snapshotId: file.dataset.snapshotId, fileId: file.dataset.fileId });
  }

  // --- toolbar, base and merge-parent controls ---

  const BUTTON_ACTIONS = {
    "history-choose-repository": () => post("chooseRepository", {}),
    "history-refresh": () => post("refresh", {}),
    "history-clear-selection": () => postSelect([], focusedOid),
    "history-base-automatic": () => post("base", { ref: null }),
    "history-base-pin": pinBase,
    "history-load-more": (button) => sendPresentation({ rowLimit: Number(button.dataset.rowLimit) }),
  };

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    const hasAction = button && Object.hasOwn(BUTTON_ACTIONS, button.id);
    if (hasAction) {
      BUTTON_ACTIONS[button.id](button);
    }
  });

  function pinBase() {
    const ref = document.getElementById(BASE_INPUT_ID).value.trim();
    if (ref === "") {
      return;
    }
    saveView({ baseDraft: null });
    post("base", { ref });
  }

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.id === "history-repository") {
      post("repository", { repositoryId: target.value });
      return;
    }
    if (target.id === "history-branch") {
      sendPresentation({ branchOid: target.value || null });
      return;
    }
    if (target.closest("select.mainline-select")) {
      post("mainline", { oid: target.dataset.oid, parentNumber: Number(target.value) });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.id === BASE_INPUT_ID && event.key === "Enter") {
      event.preventDefault();
      pinBase();
    }
  });

  // --- search: debounced; the draft survives publications until the host echoes it ---

  // The caret is restored with the text, so typing continues where it was.
  for (const type of ["input", "keyup", "mouseup"]) {
    document.addEventListener(type, saveCaret);
  }

  function saveCaret(event) {
    const target = event.target;
    const isTextInput = target.id === SEARCH_ID || target.id === BASE_INPUT_ID;
    if (isTextInput) {
      saveView({ caret: { id: target.id, start: target.selectionStart, end: target.selectionEnd } });
    }
  }

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === BASE_INPUT_ID) {
      saveView({ baseDraft: target.value });
      return;
    }
    if (target.id !== SEARCH_ID) {
      return;
    }
    // Sent even when it matches the published text: an earlier search may still be in flight.
    saveView({ searchDraft: target.value });
    cancelSearch();
    searchTimer = setTimeout(() => sendPresentation({}), SEARCH_DEBOUNCE_MS);
  });

  function restoreSearchDraft() {
    const draft = view.searchDraft;
    if (draft === null || draft === undefined) {
      return;
    }
    if (draft === published.search) {
      saveView({ searchDraft: null });
      return;
    }
    searchInput.value = draft;
    searchTimer = setTimeout(() => sendPresentation({}), SEARCH_DEBOUNCE_MS);
  }

  function cancelSearch() {
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  // --- messages ---

  /** Sends the complete presentation, folding in any search text or focus not yet sent. */
  function sendPresentation(changes) {
    cancelSearch();
    cancelFocus();
    post("presentation", {
      search: searchInput.value,
      branchOid: published.branchOid,
      focusedOid,
      rowLimit: published.rowLimit,
      ...changes,
    });
  }

  /**
   * A pending search timer is left running: if this intent causes a
   * publication, the timer dies with this document and the next one resends
   * the saved draft; if the host rejects the late search as stale, likewise.
   */
  function post(type, fields) {
    vscode.postMessage({ type, revision: published.revision, ...fields });
  }

  // --- presentation persistence ---

  function restoreView() {
    const saved = vscode.getState();
    const isSameRepository = saved && saved.repositoryId === published.repositoryId;
    const initial = {
      repositoryId: published.repositoryId,
      anchorOid: null,
      activeKey: null,
      caret: null,
      scroll: {},
      detailWidth: null,
      searchDraft: null,
      baseDraft: null,
      focusDraft: null,
    };
    return isSameRepository ? { ...initial, ...saved } : initial;
  }

  function saveView(changes) {
    view = { ...view, ...changes };
    vscode.setState(view);
  }

  /** Offsets are saved at most once per frame while scrolling. */
  function restoreScroll() {
    let isSavePending = false;
    const saveScroll = () => {
      isSavePending = false;
      const scroll = {};
      for (const paneClass of SCROLL_PANES) {
        const pane = document.querySelector(`.${paneClass}`);
        scroll[paneClass] = pane ? pane.scrollTop : 0;
      }
      saveView({ scroll });
    };
    for (const paneClass of SCROLL_PANES) {
      const pane = document.querySelector(`.${paneClass}`);
      if (!pane) {
        continue;
      }
      pane.scrollTop = view.scroll[paneClass] || 0;
      pane.addEventListener("scroll", () => {
        if (!isSavePending) {
          isSavePending = true;
          requestAnimationFrame(saveScroll);
        }
      });
    }
  }

  /**
   * The native resize grip writes an inline width, which would also override
   * the stacked narrow layout. It is moved to `--detail-width`, which only the
   * wide layout reads, and kept across publications.
   */
  function restoreDetailWidth() {
    const pane = document.querySelector(".detail-pane");
    if (!pane) {
      return;
    }
    applyDetailWidth(pane, view.detailWidth);
    document.addEventListener("mouseup", () => {
      const width = pane.style.width;
      if (!width) {
        return;
      }
      pane.style.removeProperty("width");
      applyDetailWidth(pane, width);
      if (width !== view.detailWidth) {
        saveView({ detailWidth: width });
      }
    });
  }

  function applyDetailWidth(pane, width) {
    if (PIXEL_WIDTH_PATTERN.test(width || "")) {
      pane.style.setProperty("--detail-width", width);
    }
  }

  // Focus is remembered by a stable key (control ID, file ID, merge OID), never by DOM position.
  document.addEventListener("focusin", (event) => saveView({ activeKey: focusKey(event.target) }));
  window.addEventListener("blur", () => saveView({ activeKey: null }));

  function focusKey(element) {
    if (element.closest("tr.commit-row")) {
      return "row";
    }
    const file = element.closest("button.file-row");
    if (file) {
      return `file:${file.dataset.fileId}`;
    }
    const mainline = element.closest("select.mainline-select");
    if (mainline) {
      return `mainline:${mainline.dataset.oid}`;
    }
    return element.id ? `id:${element.id}` : null;
  }

  function restoreFocus() {
    const key = view.activeKey;
    const element = key ? elementForKey(key) : null;
    const isEditingBase = element && element.id === BASE_INPUT_ID && typeof view.baseDraft === "string";
    if (isEditingBase) {
      element.value = view.baseDraft;
    } else {
      saveView({ baseDraft: null });
    }
    focusElement(element);
  }

  /** The focused row is the one with the tab stop (published focus or unsent draft), so rows share one key. */
  function elementForKey(key) {
    const [kind, value] = splitKey(key);
    const matching = (selector, attribute) => [...document.querySelectorAll(selector)].find((element) => element.dataset[attribute] === value);
    switch (kind) {
      case "row":
        return commitRows().find((row) => row.getAttribute("tabindex") === "0");
      case "file":
        return matching("button.file-row", "fileId");
      case "mainline":
        return matching("select.mainline-select", "oid");
      case "id":
        return document.getElementById(value);
      default:
        return null;
    }
  }

  function splitKey(key) {
    const separator = key.indexOf(":");
    return separator < 0 ? [key, ""] : [key.slice(0, separator), key.slice(separator + 1)];
  }

  function focusElement(element) {
    if (!element) {
      return;
    }
    element.focus();
    const isText = element.tagName === "INPUT" && typeof element.setSelectionRange === "function";
    if (!isText) {
      return;
    }
    const length = element.value.length;
    const caret = view.caret && view.caret.id === element.id ? view.caret : { start: length, end: length };
    element.setSelectionRange(Math.min(caret.start, length), Math.min(caret.end, length));
  }

  function isModifierPressed(event) {
    return event.ctrlKey || event.metaKey;
  }
})();
