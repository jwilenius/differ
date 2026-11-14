import type { MergeState } from "./mergeSession";

/** Most changes to the merge that undo can take back. */
export const MAX_UNDO_STEPS = 200;

/**
 * The merge's undo and redo: earlier and undone merge states, latest last. A page's own undo knows nothing of the
 * lines it splits, joins and colours, so the merge keeps its own.
 */
export class MergeHistory {
  private readonly undoStates: MergeState[] = [];
  private readonly redoStates: MergeState[] = [];

  /** Keeps `state` for undo when `next` changed it, dropping the oldest beyond the cap; a change forgets what was undone. */
  record(state: MergeState, next: MergeState): void {
    if (next === state) {
      return;
    }
    this.undoStates.push(state);
    if (this.undoStates.length > MAX_UNDO_STEPS) {
      this.undoStates.shift();
    }
    this.redoStates.length = 0;
  }

  /** The state before `current`; `current` itself when there is nothing to take back. */
  undo(current: MergeState): MergeState {
    return step(this.undoStates, this.redoStates, current);
  }

  /** The state `current` was undone from; `current` itself when there is nothing to put back. */
  redo(current: MergeState): MergeState {
    return step(this.redoStates, this.undoStates, current);
  }
}

/** Moves from `current` to the latest state of `from`, keeping `current` in `to`. */
function step(from: MergeState[], to: MergeState[], current: MergeState): MergeState {
  const target = from.pop();
  if (target === undefined) {
    return current;
  }
  to.push(current);
  return target;
}
