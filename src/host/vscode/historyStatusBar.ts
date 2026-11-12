import { describeResolvedBase, shortHash } from "../../model/historyLabels";
import type { HistoryState } from "../../model/historyTypes";

/** Status-bar text for the active repository: selection size, base and whether work or a problem is pending. */
export function describeHistoryStatus(repositoryName: string, state: HistoryState): string {
  return `$(git-commit) ${repositoryName}: ${state.selectedOids.length} selected · ${describeBase(state)}${describeProgress(state)}`;
}

function describeBase(state: HistoryState): string {
  if (state.base.kind === "pinned") {
    return `base ${state.base.label} (${shortHash(state.base.oid)})`;
  }
  const comparison = state.comparison;
  if (comparison === null || comparison.kind === "needsBase") {
    return "base Automatic";
  }
  return `base ${describeResolvedBase(comparison.base)}`;
}

function describeProgress(state: HistoryState): string {
  const { operations, error, comparison } = state;
  if (operations.isLoading || operations.isResolvingBase || operations.isComparing) {
    return " · working…";
  }
  if (error !== null) {
    return " · error";
  }
  if (comparison?.kind === "blocked") {
    return " · blocked";
  }
  return comparison?.kind === "needsBase" ? " · needs base" : "";
}
