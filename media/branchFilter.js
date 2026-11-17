// Branch filter for jw-differ's history client: a combobox over the hidden `#history-branch` select, the region the
// host renders. One global, `createBranchFilter`, which the history client calls; it needs `fuzzyMatch.js` loaded
// first.
//
// The input and its list are never replaced, so an open list, its query and the focus survive updates. The input
// holds the query while the list is open, its placeholder naming the chosen branch; closed, its value names the chosen
// branch, as a select's does, so screen readers announce it.
(function () {
  "use strict";

  const OPTION_ID_PREFIX = "history-branch-option-";
  /** Options added to the list at a time, as the active option or the scroll position reaches the end. */
  const PAGE_SIZE = 100;
  /** How close to the end of the list, in pixels, scrolling adds the next options. */
  const SCROLL_SLACK = 200;
  /** Space kept between the list and the input or the panel's edges, in pixels. */
  const LIST_GAP = 2;

  /**
   * Wires the combobox `input` and its listbox `list`. `isLocalBranchesOnly()` says whether the list leaves out
   * remote branches; `onPick(value)` hears the option value of a branch picked other than the shown one. Call
   * `refresh(select)` with the current `#history-branch` select at load and after every update.
   */
  function createBranchFilter({ input, list, isLocalBranchesOnly, onPick }) {
    /** The select `branches` was read from; each update that changes the branches replaces it. */
    let branchSelect = null;
    /** `{ value, label, kind, folded }` per option, in the host's order; `kind` is null for All and Checked out. */
    let branches = [];
    /** The branch the host chose: the selected option, else the first, as a select shows it. */
    let chosenBranch = null;
    /** The branch the input names: the host's choice, or one picked since. */
    let shownBranch = null;
    /** Branches matching the query, in list order; the first `shownBranchCount` have options in the list. */
    let matchingBranches = [];
    let shownBranchCount = 0;
    /** Index into `matchingBranches` of the active option; -1 when none is active. */
    let activeBranchIndex = -1;

    input.addEventListener("click", () => openBranches());
    input.addEventListener("input", (event) => {
      if (isBranchListOpen()) {
        filterBranches(null);
      } else if (!event.isComposing) {
        openBranches(insertedText(event));
      }
    });
    // Text composed while the list is closed opens it once the input method commits the text.
    input.addEventListener("compositionend", (event) => {
      if (!isBranchListOpen()) {
        openBranches(event.data || "");
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) {
        return;
      }
      if (!isBranchListOpen()) {
        const isOpenKey = event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp";
        if (isOpenKey) {
          event.preventDefault();
          openBranches();
        }
        return;
      }
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (event.key === "Escape" || (event.altKey && event.key === "ArrowUp")) {
        event.preventDefault();
        closeBranches();
      } else if (step !== undefined) {
        event.preventDefault();
        moveActiveBranch(step);
      } else if (event.key === "Enter") {
        event.preventDefault();
        pickBranch(activeBranchIndex);
      }
    });
    // Tab, a click elsewhere and leaving the panel all take the focus from the input.
    input.addEventListener("blur", () => closeBranches());
    // A press on the list would take the focus from the input and close the list before the click picks.
    list.addEventListener("mousedown", (event) => event.preventDefault());
    list.addEventListener("click", (event) => {
      const option = event.target.closest("li.branch-option");
      if (option) {
        pickBranch(Number(option.dataset.index));
      }
    });
    list.addEventListener("scroll", () => {
      const isNearEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - SCROLL_SLACK;
      if (isNearEnd) {
        showMoreBranches(shownBranchCount + PAGE_SIZE);
      }
    });
    window.addEventListener("resize", () => {
      if (isBranchListOpen()) {
        placeBranchList();
      }
    });

    /**
     * Reads the branches again when an update replaced the select, refiltering an open list on the same active option,
     * and names the chosen branch, which a pick may have shown before the host took it.
     */
    function refresh(select) {
      const isReplaced = select !== branchSelect;
      if (isReplaced) {
        branchSelect = select;
        const options = [...select.querySelectorAll("option")];
        branches = options.map((option) => ({
          value: option.value,
          label: option.textContent,
          kind: option.dataset.kind || null,
          folded: fuzzyMatch.foldForMatch(option.textContent),
        }));
        const chosenIndex = options.findIndex((option) => option.hasAttribute("selected"));
        chosenBranch = branches[Math.max(chosenIndex, 0)];
      }
      // Named before refiltering, so the new options mark the chosen branch.
      showChosenBranch(chosenBranch);
      if (!isBranchListOpen()) {
        return;
      }
      if (isReplaced) {
        const active = matchingBranches[activeBranchIndex];
        filterBranches(active ? active.value : initialActiveValue());
      } else {
        placeBranchList();
      }
    }

    function showChosenBranch(branch) {
      shownBranch = branch;
      input.placeholder = branch.label;
      input.title = branch.label;
      if (!isBranchListOpen()) {
        input.value = branch.label;
      }
    }

    function isBranchListOpen() {
      return !list.hidden;
    }

    /**
     * Opens the list with `query` replacing the chosen branch's name in the input: on the chosen branch for no query,
     * else on the first match.
     */
    function openBranches(query = "") {
      if (isBranchListOpen()) {
        return;
      }
      input.value = query;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      filterBranches(initialActiveValue());
    }

    /** With no query, the chosen branch's option; with one, null for the first match. */
    function initialActiveValue() {
      return input.value === "" ? shownBranch.value : null;
    }

    /** Typing into the closed input starts a fresh query with the typed text; a deletion starts an empty one. */
    function insertedText(event) {
      const isInsertion = typeof event.inputType === "string" && event.inputType.startsWith("insert");
      return isInsertion && event.data ? event.data : "";
    }

    /** Closing forgets the query and names the shown branch again. */
    function closeBranches() {
      if (!isBranchListOpen()) {
        return;
      }
      list.hidden = true;
      list.replaceChildren();
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      input.value = shownBranch.label;
      matchingBranches = [];
      shownBranchCount = 0;
      activeBranchIndex = -1;
    }

    /**
     * Lists the offered branches matching the query and makes `activeValue`'s option active, or the first for null.
     * When `activeValue` is not among them, as a chosen remote branch is not while local branches only are offered, no
     * option is active: Enter then closes the list without picking a branch the user never moved to.
     */
    function filterBranches(activeValue) {
      const query = fuzzyMatch.foldForMatch(input.value);
      matchingBranches = branches.filter((branch) => isOfferedBranch(branch) && fuzzyMatch.isFuzzyMatch(query, branch.folded));
      const kept = matchingBranches.findIndex((branch) => branch.value === activeValue);
      list.replaceChildren();
      shownBranchCount = 0;
      activeBranchIndex = -1;
      if (matchingBranches.length === 0) {
        input.removeAttribute("aria-activedescendant");
        const empty = document.createElement("li");
        empty.className = "branch-empty";
        empty.setAttribute("role", "presentation");
        empty.textContent = "No matching branches";
        list.append(empty);
        placeBranchList();
        return;
      }
      showMoreBranches(PAGE_SIZE);
      const isActiveLeftOut = activeValue !== null && kept < 0;
      if (isActiveLeftOut) {
        input.removeAttribute("aria-activedescendant");
        return;
      }
      setActiveBranch(Math.max(kept, 0));
    }

    /** Local only, every branch but the remote ones: All branches, Checked out, local branches and a detached HEAD. */
    function isOfferedBranch(branch) {
      return !isLocalBranchesOnly() || branch.kind !== "remoteBranch";
    }

    /** Adds options until `count` of the matching branches are shown. */
    function showMoreBranches(count) {
      const query = fuzzyMatch.foldForMatch(input.value);
      const end = Math.min(count, matchingBranches.length);
      const added = [];
      for (let index = shownBranchCount; index < end; index++) {
        added.push(branchOption(matchingBranches[index], index, query));
      }
      list.append(...added);
      shownBranchCount = Math.max(shownBranchCount, end);
      // The list's height and width follow its options.
      placeBranchList();
    }

    /** The matched letters are marked with text nodes and elements, never parsed markup: branch names are user data. */
    function branchOption(branch, index, query) {
      const option = document.createElement("li");
      option.id = OPTION_ID_PREFIX + index;
      option.className = branch === shownBranch ? "branch-option is-chosen" : "branch-option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.setAttribute("aria-setsize", String(matchingBranches.length));
      option.setAttribute("aria-posinset", String(index + 1));
      option.dataset.index = String(index);
      let offset = 0;
      for (const range of fuzzyMatch.fuzzyMatchRanges(query, branch.label) || []) {
        const mark = document.createElement("mark");
        mark.textContent = branch.label.slice(range.start, range.end);
        option.append(branch.label.slice(offset, range.start), mark);
        offset = range.end;
      }
      option.append(branch.label.slice(offset));
      return option;
    }

    /** With no option active, either arrow makes the first one active. */
    function moveActiveBranch(step) {
      if (matchingBranches.length === 0) {
        return;
      }
      setActiveBranch(Math.min(Math.max(activeBranchIndex + step, 0), matchingBranches.length - 1));
    }

    function setActiveBranch(index) {
      const previous = document.getElementById(OPTION_ID_PREFIX + activeBranchIndex);
      if (previous) {
        previous.classList.toggle("is-active", false);
        previous.setAttribute("aria-selected", "false");
      }
      if (index >= shownBranchCount) {
        showMoreBranches(index + PAGE_SIZE);
      }
      activeBranchIndex = index;
      const option = document.getElementById(OPTION_ID_PREFIX + index);
      option.classList.toggle("is-active", true);
      option.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    }

    /** Closes the list; a branch other than the shown one is shown at once and handed to `onPick`. */
    function pickBranch(index) {
      const branch = matchingBranches[index];
      closeBranches();
      if (!branch || branch === shownBranch) {
        return;
      }
      showChosenBranch(branch);
      onPick(branch.value);
    }

    /** Fixed, so the panel's edges do not clip it: below the input, or above when there is more room there. */
    function placeBranchList() {
      const inputBox = input.getBoundingClientRect();
      const roomBelow = window.innerHeight - inputBox.bottom - 2 * LIST_GAP;
      const roomAbove = inputBox.top - 2 * LIST_GAP;
      const isBelow = roomBelow >= list.scrollHeight || roomBelow >= roomAbove;
      const style = list.style;
      style.minWidth = `${inputBox.width}px`;
      style.maxWidth = `${window.innerWidth - 2 * LIST_GAP}px`;
      style.maxHeight = `${Math.max(isBelow ? roomBelow : roomAbove, 0)}px`;
      style.top = isBelow ? `${inputBox.bottom + LIST_GAP}px` : "auto";
      style.bottom = isBelow ? "auto" : `${window.innerHeight - inputBox.top + LIST_GAP}px`;
      const left = Math.min(inputBox.left, window.innerWidth - list.offsetWidth - LIST_GAP);
      style.left = `${Math.max(left, LIST_GAP)}px`;
    }

    return { refresh };
  }

  globalThis.createBranchFilter = createBranchFilter;
})();
