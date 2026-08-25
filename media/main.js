(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const grid = document.getElementById("grid");
  let focusedConflict = -1;

  grid.addEventListener("click", (event) => {
    const button = event.target.closest("button.resolve");
    if (!button) {
      return;
    }
    button.closest(".action-bar").classList.add("resolved");
    vscode.postMessage({
      type: "resolve",
      conflictIndex: Number(button.dataset.conflict),
      resolution: button.dataset.resolution,
    });
  });

  document.getElementById("next").addEventListener("click", () => moveToConflict(1));
  document.getElementById("prev").addEventListener("click", () => moveToConflict(-1));

  document.addEventListener("keydown", (event) => {
    if (event.key === "F7" || (event.altKey && event.key === "ArrowDown")) {
      moveToConflict(1);
      event.preventDefault();
    }
    if ((event.shiftKey && event.key === "F7") || (event.altKey && event.key === "ArrowUp")) {
      moveToConflict(-1);
      event.preventDefault();
    }
  });

  function moveToConflict(step) {
    const bars = Array.from(document.querySelectorAll(".action-bar"));
    if (bars.length === 0) {
      return;
    }

    focusedConflict = clamp(focusedConflict + step, bars.length);
    bars[focusedConflict].scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function clamp(index, length) {
    if (index < 0) {
      return length - 1;
    }
    if (index >= length) {
      return 0;
    }
    return index;
  }

  const state = vscode.getState();
  if (state && typeof state.scrollY === "number") {
    window.scrollTo(0, state.scrollY);
  }

  window.addEventListener("scroll", () => {
    vscode.setState({ scrollY: window.scrollY });
  });
})();
