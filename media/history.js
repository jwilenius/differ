// History panel client. It reads the published state from `body[data-history]`,
// restores focus/scroll/drafts saved with `setState` (VS Code recreates the
// document when the panel is shown again), and posts typed intents. Later
// publications arrive as `update` messages that patch this document in place.
// Selection is computed by full OID, starting from the published state; the
// client never touches Git.
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
  let published = JSON.parse(document.body.dataset.history);
  const searchInput = document.getElementById(SEARCH_ID);

  /**
   * Presentation kept by the iframe across publications of one repository:
   * range anchor, last focused control, caret, pane scroll offsets, unsent
   * text or focus, the file last marked as open in the diff view, and whether
   * the branch list offers local branches only.
   */
  let view = restoreView();
  /**
   * Selection and focus as last sent: several gestures can be made before the
   * update showing the first one arrives, and each must build on the last.
   */
  let selection = published.selectedOids;
  let focusedOid = published.focusedOid;
  let searchTimer = null;
  let focusTimer = null;

  post("ready", {});
  restoreScroll();
  restoreDetailWidth();
  syncSearch();
  restoreFocusDraft();
  restoreFocus();
  showOpenFile();

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
    const rendered = renderedOids();
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
    const rendered = renderedOids();
    const candidates = [view.anchorOid, focusedOid, fallbackOid];
    return candidates.find((oid) => oid && rendered.includes(oid)) || fallbackOid;
  }

  function renderedRange(fromOid, toOid) {
    const rendered = renderedOids();
    const from = rendered.indexOf(fromOid);
    const to = rendered.indexOf(toOid);
    return rendered.slice(Math.min(from, to), Math.max(from, to) + 1);
  }

  function unrenderedSelection() {
    const rendered = new Set(renderedOids());
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

  /** Rows present in the table, in display order. */
  function renderedOids() {
    return commitRows().map((row) => row.dataset.oid);
  }

  /** Marks `oid`'s row as focused and gives it the tab stop, as the renderer would; unrendered focus keeps the tab stop. */
  function showFocus(oid) {
    focusedOid = oid;
    const rows = commitRows();
    const isRendered = rows.some((row) => row.dataset.oid === oid);
    for (const row of rows) {
      const isFocused = row.dataset.oid === oid;
      row.classList.toggle("is-focused", isFocused);
      if (isRendered) {
        row.setAttribute("tabindex", isFocused ? "0" : "-1");
      }
      if (isFocused) {
        row.setAttribute("aria-current", "true");
      } else {
        row.removeAttribute("aria-current");
      }
    }
  }

  function showSelection() {
    const selected = new Set(selection);
    for (const row of commitRows()) {
      const isSelected = selected.has(row.dataset.oid);
      row.classList.toggle("is-selected", isSelected);
      row.setAttribute("aria-selected", String(isSelected));
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

  /** A focus not yet sent when a publication arrived is shown again and sent, unless it is already waiting to be. */
  function restoreFocusDraft() {
    const draft = view.focusDraft;
    if (!draft) {
      return;
    }
    const isSettled = draft === published.focusedOid || !renderedOids().includes(draft);
    if (isSettled) {
      saveView({ focusDraft: null });
      return;
    }
    showFocus(draft);
    if (focusTimer === null) {
      scheduleFocus();
    }
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

  /**
   * Marks the file the diff panel shows. When the panel moves on from a file or its tab closes, that file's row is
   * deselected: it keeps no focus from the double-click that opened it. A newly shown file is scrolled into view.
   * The file last marked is kept with the view, so a document recreated after the panel was hidden does the same.
   */
  function showOpenFile() {
    const previousId = view.openFileId;
    const openId = published.openFileId;
    for (const file of fileRows()) {
      const isOpen = file.dataset.fileId === openId;
      file.classList.toggle("is-open", isOpen);
      if (isOpen) {
        file.setAttribute("aria-current", "true");
      } else {
        file.removeAttribute("aria-current");
      }
    }
    if (previousId === openId) {
      return;
    }
    saveView({ openFileId: openId });
    const closed = fileRows().find((file) => file.dataset.fileId === previousId);
    if (closed) {
      deselectFile(closed);
    }
    const opened = fileRows().find((file) => file.dataset.fileId === openId);
    if (opened) {
      opened.scrollIntoView({ block: "nearest" });
    }
  }

  function deselectFile(file) {
    if (document.activeElement === file) {
      file.blur();
    }
    if (view.activeKey === `file:${file.dataset.fileId}`) {
      saveView({ activeKey: null });
    }
  }

  function fileRows() {
    return [...document.querySelectorAll("button.file-row")];
  }

  // --- toolbar, base and merge-parent controls ---

  const BUTTON_ACTIONS = {
    "history-choose-repository": () => post("chooseRepository", {}),
    "history-refresh": () => post("refresh", {}),
    "history-clear-selection": () => postSelect([], focusedOid),
    "history-base-automatic": () => post("base", { ref: null }),
    "history-base-pin": pinBase,
    "history-load-more": (button) => sendPresentation({ rowLimit: Number(button.dataset.rowLimit) }),
    "history-branch-local-only": toggleLocalBranchesOnly,
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

  /**
   * Shows the unsent search text, or else the published one. The text is sent
   * again, unless already waiting to be, until the host publishes it: the host
   * takes only focus from an intent sent before its latest publication.
   */
  function syncSearch() {
    if (view.searchDraft === published.search) {
      saveView({ searchDraft: null });
    }
    const draft = view.searchDraft;
    const hasDraft = typeof draft === "string";
    const text = hasDraft ? draft : published.search;
    if (searchInput.value !== text) {
      searchInput.value = text;
    }
    if (hasDraft && searchTimer === null) {
      searchTimer = setTimeout(() => sendPresentation({}), SEARCH_DEBOUNCE_MS);
    }
  }

  function cancelSearch() {
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  // --- branch filter: `branchFilter.js` runs the combobox; the local-only toggle is kept with the view ---

  const BRANCH_SELECT_ID = "history-branch";
  /** Pressed, the list leaves out remote branches; it filters the list only, never the history. */
  const localOnlyToggle = document.getElementById("history-branch-local-only");
  const branchFilter = createBranchFilter({
    input: document.getElementById("history-branch-input"),
    list: document.getElementById("history-branch-list"),
    isLocalBranchesOnly: () => view.isLocalBranchesOnly,
    onPick: (value) => sendPresentation({ branch: value || null }),
  });
  showLocalBranchesOnly();
  refreshBranches();

  function toggleLocalBranchesOnly() {
    saveView({ isLocalBranchesOnly: !view.isLocalBranchesOnly });
    showLocalBranchesOnly();
  }

  /** The tooltip says what a click does now; the accessible name stays, `aria-pressed` tells the state. */
  function showLocalBranchesOnly() {
    localOnlyToggle.setAttribute("aria-pressed", String(view.isLocalBranchesOnly));
    localOnlyToggle.title = view.isLocalBranchesOnly
      ? "Showing local branches only in the branch list; click to list remote branches too"
      : "Show local branches only in the branch list; the history shown is unchanged";
  }

  /** The select is a region: an update may have replaced it. */
  function refreshBranches() {
    branchFilter.refresh(document.getElementById(BRANCH_SELECT_ID));
  }

  // --- messages ---

  /** Sends the complete presentation, folding in any search text or focus not yet sent. */
  function sendPresentation(changes) {
    cancelSearch();
    cancelFocus();
    post("presentation", {
      search: searchInput.value,
      branch: published.branch,
      focusedOid,
      rowLimit: published.rowLimit,
      ...changes,
    });
  }

  /** A pending search timer is left running; the draft is resent until the host publishes it. */
  function post(type, fields) {
    vscode.postMessage({ type, revision: published.revision, ...fields });
  }

  // --- updates: changed elements by ID, appended rows and the new published state ---

  window.addEventListener("message", (event) => {
    const message = event.data;
    const isNewer = message && message.type === "update" && message.state.revision > published.revision;
    if (isNewer) {
      applyUpdate(message);
    }
  });

  function applyUpdate(update) {
    const active = document.activeElement;
    for (const [id, markup] of Object.entries(update.regions)) {
      document.getElementById(id).outerHTML = markup;
    }
    if (update.appendedRows) {
      document.getElementById("history-commits").querySelector("tbody.commit-rows").insertAdjacentHTML("beforeend", update.appendedRows);
    }
    const isSameRepository = update.state.repositoryId === published.repositoryId;
    published = update.state;
    selection = published.selectedOids;
    if (!isSameRepository) {
      forgetRepository();
    }
    showSelection();
    showFocus(published.focusedOid);
    resetSelects();
    syncSearch();
    refreshBranches();
    restoreFocusDraft();
    if (active && !active.isConnected) {
      restoreFocus();
    }
    showOpenFile();
  }

  /** Nothing carries over to another repository but the focused control, caret, detail width and local-only toggle. */
  function forgetRepository() {
    cancelSearch();
    cancelFocus();
    saveView({ repositoryId: published.repositoryId, anchorOid: null, scroll: {}, searchDraft: null, baseDraft: null, focusDraft: null });
    for (const paneClass of SCROLL_PANES) {
      const pane = document.querySelector(`.${paneClass}`);
      if (pane) {
        pane.scrollTop = 0;
      }
    }
  }

  /** Selects show the host's choice, so a change it did not take is undone. */
  function resetSelects() {
    for (const select of document.querySelectorAll("select")) {
      const options = [...select.querySelectorAll("option")];
      const chosen = options.find((option) => option.hasAttribute("selected")) || options[0];
      if (chosen) {
        select.value = chosen.value;
      }
    }
  }

  // --- presentation persistence ---

  function restoreView() {
    const saved = vscode.getState();
    const isSameRepository = saved && saved.repositoryId === published.repositoryId;
    // The local-only toggle is the panel's, kept for every repository.
    const isLocalBranchesOnly = Boolean(saved && saved.isLocalBranchesOnly);
    const initial = {
      repositoryId: published.repositoryId,
      anchorOid: null,
      activeKey: null,
      openFileId: null,
      caret: null,
      scroll: {},
      detailWidth: null,
      searchDraft: null,
      baseDraft: null,
      focusDraft: null,
      isLocalBranchesOnly,
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
