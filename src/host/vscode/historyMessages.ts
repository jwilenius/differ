/**
 * Intents posted by `media/history.js`. Every message echoes the wire revision
 * of the publication it was computed from; the host compares it with the
 * current revision. Parsing checks shape only: membership in the loaded
 * history, allowed merge parents and known snapshot/file/root IDs are checked
 * by the host against its own state.
 */
export type HistoryMessage =
  | { readonly type: "ready"; readonly revision: number }
  | {
    readonly type: "select";
    readonly revision: number;
    readonly oids: readonly string[];
    readonly focusedOid: string | null;
  }
  /** `ref` is a commit, branch or tag to pin; null returns to Automatic. */
  | { readonly type: "base"; readonly revision: number; readonly ref: string | null }
  | { readonly type: "mainline"; readonly revision: number; readonly oid: string; readonly parentNumber: number }
  | { readonly type: "openFile"; readonly revision: number; readonly snapshotId: string; readonly fileId: string }
  | { readonly type: "refresh"; readonly revision: number }
  | { readonly type: "repository"; readonly revision: number; readonly repositoryId: string }
  | { readonly type: "chooseRepository"; readonly revision: number }
  | {
    readonly type: "presentation";
    readonly revision: number;
    readonly search: string;
    readonly branchOid: string | null;
    readonly focusedOid: string | null;
    readonly rowLimit: number;
  };

export type HistoryMessageType = HistoryMessage["type"];

/** Longest search text or base ref accepted from the webview. */
export const MAX_HISTORY_TEXT_LENGTH = 4096;

const FULL_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

type Fields = Readonly<Record<string, unknown>>;

interface MessageSchema {
  /** Fields besides `type` and `revision`, which every message has. */
  readonly fields: readonly string[];
  readonly parse: (fields: Fields, revision: number) => HistoryMessage | null;
}

const SCHEMAS: Readonly<Record<HistoryMessageType, MessageSchema>> = {
  ready: { fields: [], parse: (_fields, revision) => ({ type: "ready", revision }) },
  select: { fields: ["oids", "focusedOid"], parse: parseSelect },
  base: { fields: ["ref"], parse: parseBase },
  mainline: { fields: ["oid", "parentNumber"], parse: parseMainline },
  openFile: { fields: ["snapshotId", "fileId"], parse: parseOpenFile },
  refresh: { fields: [], parse: (_fields, revision) => ({ type: "refresh", revision }) },
  repository: { fields: ["repositoryId"], parse: parseRepository },
  chooseRepository: { fields: [], parse: (_fields, revision) => ({ type: "chooseRepository", revision }) },
  presentation: { fields: ["search", "branchOid", "focusedOid", "rowLimit"], parse: parsePresentation },
};

/**
 * Returns a freshly built message when `value` has exactly the fields of one
 * known message type with valid values, otherwise null.
 */
export function parseHistoryMessage(value: unknown): HistoryMessage | null {
  if (!isRecord(value) || !isMessageType(value.type) || !isRevision(value.revision)) {
    return null;
  }
  const schema = SCHEMAS[value.type];
  const expected = ["type", "revision", ...schema.fields];
  const hasExactFields = Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
  if (!hasExactFields) {
    return null;
  }
  return schema.parse(value, value.revision);
}

function parseSelect(fields: Fields, revision: number): HistoryMessage | null {
  const { oids, focusedOid } = fields;
  const isValid = Array.isArray(oids) && oids.every(isFullOid) && new Set(oids).size === oids.length && isOidOrNull(focusedOid);
  return isValid ? { type: "select", revision, oids: [...oids], focusedOid } : null;
}

function parseBase(fields: Fields, revision: number): HistoryMessage | null {
  const { ref } = fields;
  const isValid = ref === null || (isBoundedText(ref) && ref.trim() !== "" && !CONTROL_CHARACTER_PATTERN.test(ref));
  return isValid ? { type: "base", revision, ref } : null;
}

function parseMainline(fields: Fields, revision: number): HistoryMessage | null {
  const { oid, parentNumber } = fields;
  const isValid = isFullOid(oid) && isPositiveInteger(parentNumber);
  return isValid ? { type: "mainline", revision, oid, parentNumber } : null;
}

function parseOpenFile(fields: Fields, revision: number): HistoryMessage | null {
  const { snapshotId, fileId } = fields;
  return isUuid(snapshotId) && isUuid(fileId) ? { type: "openFile", revision, snapshotId, fileId } : null;
}

function parseRepository(fields: Fields, revision: number): HistoryMessage | null {
  const { repositoryId } = fields;
  return isUuid(repositoryId) ? { type: "repository", revision, repositoryId } : null;
}

function parsePresentation(fields: Fields, revision: number): HistoryMessage | null {
  const { search, branchOid, focusedOid, rowLimit } = fields;
  const isValid = isBoundedText(search) && isOidOrNull(branchOid) && isOidOrNull(focusedOid) && isPositiveInteger(rowLimit);
  return isValid ? { type: "presentation", revision, search, branchOid, focusedOid, rowLimit } : null;
}

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageType(value: unknown): value is HistoryMessageType {
  return typeof value === "string" && Object.hasOwn(SCHEMAS, value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isFullOid(value: unknown): value is string {
  return typeof value === "string" && FULL_OID_PATTERN.test(value);
}

function isOidOrNull(value: unknown): value is string | null {
  return value === null || isFullOid(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_HISTORY_TEXT_LENGTH;
}
