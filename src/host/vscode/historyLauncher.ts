import * as vscode from "vscode";

/** The view of jw-differ's Activity Bar container; an Activity Bar icon can only show a side-bar view, not the panel. */
export const HISTORY_LAUNCHER_VIEW_ID = "jwDiffer.launcher";

const SHOW_EXPLORER_COMMAND = "workbench.view.explorer";
const CLOSE_SIDE_BAR_COMMAND = "workbench.action.closeSidebar";

/** No items, so VS Code shows the view's welcome content: a link to the panel for when the redirect is not taken. */
const EMPTY_TREE: vscode.TreeDataProvider<never> = {
  getChildren: () => [],
  getTreeItem: (element) => element,
};

/**
 * Turns showing the launcher, by its Activity Bar icon or command, into showing the history panel. The redirect leaves
 * the Explorer as the side bar's container, so reloading the window restores neither the launcher nor a redirect.
 */
export function registerHistoryLauncher(openHistory: () => Promise<void>): vscode.Disposable {
  const launcher = vscode.window.createTreeView(HISTORY_LAUNCHER_VIEW_ID, { treeDataProvider: EMPTY_TREE });
  const visibilitySubscription = launcher.onDidChangeVisibility(({ visible }) => {
    if (visible) {
      void showHistoryInstead(openHistory);
    }
  });
  return vscode.Disposable.from(visibilitySubscription, launcher);
}

/**
 * Closes the side bar on the Explorer before opening the panel. The API cannot tell which container the click
 * replaced, and leaving the launcher as the side bar's container would make toggling the side bar open the panel.
 */
async function showHistoryInstead(openHistory: () => Promise<void>): Promise<void> {
  await vscode.commands.executeCommand(SHOW_EXPLORER_COMMAND);
  await vscode.commands.executeCommand(CLOSE_SIDE_BAR_COMMAND);
  await openHistory();
}
