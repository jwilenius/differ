import * as path from "node:path";
import * as vscode from "vscode";
import {
  type ChangeComparison,
  type ChangeReadResult,
  type ChangeSide,
  readStagedChange,
  readWorkingTreeChange,
  type UnreadableChangeReason,
} from "../../git/gitWorkingChanges";
import type { DiffSide, TwoWayDiffPanels } from "./twoWayDiffPanel";

export const OPEN_WORKING_TREE_CHANGE_COMMAND = "jwDiffer.openWorkingTreeChange";
export const OPEN_STAGED_CHANGE_COMMAND = "jwDiffer.openStagedChange";
/** The Git extension's command that shows a Source Control change in VS Code's own diff editor. */
const GIT_OPEN_CHANGE_COMMAND = "git.openChange";

/**
 * What a command receives from Source Control: the clicked change, or every selected change, in the view's order, when
 * the clicked one is selected. A URI names a file directly, as when run with `executeCommand`.
 */
type ChangeTarget = vscode.Uri | vscode.SourceControlResourceState;

/**
 * The Git extension's numbers for the Source Control groups a command's icon shows in, which its resource states carry
 * as `resourceGroupType`: Staged Changes, and Changes with Untracked Changes. Not VS Code API, so a state without one
 * counts as in the group.
 */
const INDEX_GROUP_TYPES: readonly number[] = [1];
const WORKING_TREE_GROUP_TYPES: readonly number[] = [2, 3];

/** The diff tab the changes open in. */
type ChangePanels = Pick<TwoWayDiffPanels, "open">;

const UNREADABLE_DESCRIPTIONS: Readonly<Record<UnreadableChangeReason, string>> = {
  binary: "is binary",
  invalidEncoding: "is not UTF-8 text",
  oversize: "is too large",
  notAFile: "is not a file",
};

/**
 * Registers the commands that open the Source Control view's uncommitted changes in the jw-differ diff tab: the
 * unstaged change of a file in Changes, and the staged change of a file in Staged Changes. Each opens the first
 * change it is given from its own group, or without one, as from the Command Palette, the active editor's file. Only
 * the latest request opens, so a slow read never replaces a change clicked after it. `platform` decides whether file
 * paths ignore case.
 */
export function registerScmChangeCommands(
  diffPanels: ChangePanels,
  log: (message: string) => void,
  platform: NodeJS.Platform = process.platform,
): vscode.Disposable {
  let latestRequest = 0;
  const readWorkingTree: ChangeReader = (uri) => readWorkingTreeChange(uri.fsPath, unsavedText(uri, platform));
  const open = async (read: ChangeReader, groupTypes: readonly number[], targets: readonly unknown[]): Promise<void> => {
    const request = ++latestRequest;
    const target = firstTarget(targets, groupTypes);
    if (target === undefined) {
      void vscode.window.showInformationMessage("Open a file to see its changes in jw-differ.");
      return;
    }
    await openChange({ diffPanels, log, read, target, isLatest: () => request === latestRequest });
  };

  return vscode.Disposable.from(
    vscode.commands.registerCommand(
      OPEN_WORKING_TREE_CHANGE_COMMAND,
      (...targets: unknown[]) => open(readWorkingTree, WORKING_TREE_GROUP_TYPES, targets),
    ),
    vscode.commands.registerCommand(OPEN_STAGED_CHANGE_COMMAND, (...targets: unknown[]) => open(readStaged, INDEX_GROUP_TYPES, targets)),
  );
}

/** Reads one kind of change of the file at `uri`. */
type ChangeReader = (uri: vscode.Uri) => Promise<ChangeReadResult>;

/** The working tree's side is the editor's text when the file has unsaved edits, as VS Code's own diff shows it. */
function unsavedText(uri: vscode.Uri, platform: NodeJS.Platform): string | undefined {
  const unsavedDocument = vscode.workspace.textDocuments.find(
    (document) => document.isDirty && isSameResource(document.uri, uri, platform),
  );
  return unsavedDocument?.getText();
}

/**
 * Whether two URIs name the same resource. File paths ignore case off Linux, as VS Code compares them: Source Control
 * names a file with Git's casing of the repository, an editor with the casing the folder was opened with.
 */
function isSameResource(a: vscode.Uri, b: vscode.Uri, platform: NodeJS.Platform): boolean {
  if (platform !== "linux" && a.scheme === "file" && b.scheme === "file") {
    return a.fsPath.toLowerCase() === b.fsPath.toLowerCase();
  }
  return a.toString() === b.toString();
}

function readStaged(uri: vscode.Uri): Promise<ChangeReadResult> {
  return readStagedChange(uri.fsPath);
}

/**
 * The first change a menu passed from the command's own groups: a selection can span groups, and the clicked change is
 * in the group whose icon was clicked. The first change at all when none is, and the active editor's file when none
 * was passed.
 */
function firstTarget(targets: readonly unknown[], groupTypes: readonly number[]): ChangeTarget | undefined {
  const changes = targets.filter((target) => target instanceof vscode.Uri || isResourceState(target));
  const [first] = changes;
  if (first !== undefined) {
    return changes.find((change) => isInGroups(change, groupTypes)) ?? first;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  return activeUri?.scheme === "file" ? activeUri : undefined;
}

/** Whether `change` is in one of the Git extension's groups `groupTypes`; true when it does not say. */
function isInGroups(change: ChangeTarget, groupTypes: readonly number[]): boolean {
  const groupType = change instanceof vscode.Uri ? undefined : (change as { readonly resourceGroupType?: unknown }).resourceGroupType;
  return typeof groupType !== "number" || groupTypes.includes(groupType);
}

function isResourceState(value: unknown): value is vscode.SourceControlResourceState {
  const resourceUri = typeof value === "object" && value !== null
    ? (value as Partial<vscode.SourceControlResourceState>).resourceUri
    : undefined;
  return resourceUri instanceof vscode.Uri;
}

interface ChangeOpening {
  readonly diffPanels: ChangePanels;
  readonly log: (message: string) => void;
  readonly read: ChangeReader;
  readonly target: ChangeTarget;
  /** False once a later request started, so this one opens nothing. */
  readonly isLatest: () => boolean;
}

/**
 * Shows the change in the diff tab as a snapshot, which does not follow later edits. A change jw-differ cannot show
 * as text opens in VS Code's own diff editor instead.
 */
async function openChange({ diffPanels, log, read, target, isLatest }: ChangeOpening): Promise<void> {
  const uri = target instanceof vscode.Uri ? target : target.resourceUri;
  const fileName = path.basename(uri.fsPath);
  const openNative = (): Thenable<unknown> => vscode.commands.executeCommand(GIT_OPEN_CHANGE_COMMAND, target);
  try {
    const change = await read(uri);
    if (!isLatest()) {
      return;
    }
    if ("unreadable" in change) {
      const reason = UNREADABLE_DESCRIPTIONS[change.unreadable];
      void vscode.window.showInformationMessage(`${fileName} ${reason}, so VS Code's diff shows it.`);
      await openNative();
      return;
    }
    await diffPanels.open({
      title: changeTitle(change),
      base: diffSide(uri, change.base),
      result: diffSide(uri, change.result),
      languageUri: uri,
      openNative,
      release: () => undefined,
      ...(change.hasResultFile ? { workingCopy: uri } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Opening the change of ${uri.fsPath} failed. ${message}`);
    void vscode.window.showErrorMessage(`jw-differ could not open the change of ${fileName}. ${message}`);
  }
}

/** The panel reads only a side's text, label and path; its URI names the file the change belongs to. */
function diffSide(uri: vscode.Uri, side: ChangeSide): DiffSide {
  return { uri, text: side.text, label: side.label, path: side.path };
}

/** The file's path, or both for a rename, and the two versions compared, as `src/a.ts (Index ↔ Working Tree)`. */
function changeTitle({ base, result }: ChangeComparison): string {
  const isRename = base.path !== "" && result.path !== "" && base.path !== result.path;
  const fileLabel = isRename ? `${base.path} → ${result.path}` : result.path || base.path;
  return `${fileLabel} (${base.label} ↔ ${result.label})`;
}
