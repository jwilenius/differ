import { describe, expect, it } from "vitest";
import { MAX_UNDO_STEPS, MergeHistory } from "../model/mergeHistory";
import { editLine, startMerge, type MergeState } from "../model/mergeSession";

const START = startMerge("a\nb", "a\nB", "a\nb");

/** Records `count` edits of line 0 from `state` in `history`, returning the states after each, first the start. */
function recordEdits(history: MergeHistory, state: MergeState, count: number): MergeState[] {
  const states = [state];
  for (let edit = 1; edit <= count; edit++) {
    const next = editLine(states[states.length - 1], 0, `edit ${edit}`);
    history.record(states[states.length - 1], next);
    states.push(next);
  }
  return states;
}

describe("MergeHistory", () => {
  it("undoes and redoes recorded changes in order", () => {
    const history = new MergeHistory();
    const [first, second, third] = recordEdits(history, START, 2);

    expect(history.undo(third)).toBe(second);
    expect(history.undo(second)).toBe(first);
    expect(history.redo(first)).toBe(second);
    expect(history.redo(second)).toBe(third);
  });

  it("returns the current state when there is nothing to undo or redo", () => {
    const history = new MergeHistory();

    expect(history.undo(START)).toBe(START);
    expect(history.redo(START)).toBe(START);
  });

  it("records nothing when a change left the state as it was", () => {
    const history = new MergeHistory();

    history.record(START, START);

    expect(history.undo(START)).toBe(START);
  });

  it("forgets what was undone once a new change is recorded", () => {
    const history = new MergeHistory();
    const [first, second] = recordEdits(history, START, 1);
    history.undo(second);

    const branch = editLine(first, 0, "branch");
    history.record(first, branch);

    expect(history.redo(branch)).toBe(branch);
    expect(history.undo(branch)).toBe(first);
  });

  it("keeps only the latest changes beyond the cap", () => {
    const history = new MergeHistory();
    const states = recordEdits(history, START, MAX_UNDO_STEPS + 1);

    let current = states[states.length - 1];
    for (let step = 0; step < MAX_UNDO_STEPS; step++) {
      current = history.undo(current);
    }

    expect(current).toBe(states[1]);
    expect(history.undo(current)).toBe(states[1]);
  });
});
