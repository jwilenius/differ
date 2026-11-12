import { describe, expect, it, vi } from "vitest";
import { MAX_HISTORY_TEXT_LENGTH, parseHistoryMessage } from "../host/vscode/historyMessages";
import type { HistoryMessage } from "../host/vscode/historyMessages";

const OID = "a".repeat(40);
const SHA256_OID = "b".repeat(64);
const SNAPSHOT_ID = "6f1c2a7e-1111-4222-8333-944455556666";
const FILE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const ROOT_ID = "11111111-2222-4333-8444-555555555555";

const VALID_MESSAGES: readonly HistoryMessage[] = [
  { type: "ready", revision: 0 },
  { type: "select", revision: 3, oids: [OID, SHA256_OID], focusedOid: OID },
  { type: "select", revision: 3, oids: [], focusedOid: null },
  { type: "base", revision: 3, ref: "origin/main" },
  { type: "base", revision: 3, ref: null },
  { type: "mainline", revision: 3, oid: OID, parentNumber: 2 },
  { type: "openFile", revision: 3, snapshotId: SNAPSHOT_ID, fileId: FILE_ID },
  { type: "refresh", revision: 3 },
  { type: "repository", revision: 3, repositoryId: ROOT_ID },
  { type: "chooseRepository", revision: 3 },
  { type: "presentation", revision: 3, search: "fix", branchOid: OID, focusedOid: null, rowLimit: 400 },
];

/** Stands in for the host: only parsed messages reach the handler. */
function dispatch(value: unknown, handle: (message: HistoryMessage) => void): void {
  const message = parseHistoryMessage(value);
  if (message !== null) {
    handle(message);
  }
}

describe("parseHistoryMessage", () => {
  it.each(VALID_MESSAGES.map((message) => [message.type, message] as const))("accepts a valid %s message", (_type, message) => {
    expect(parseHistoryMessage(message)).toEqual(message);
  });

  it("returns a copy that does not share the incoming selection array", () => {
    const oids = [OID];
    const message = parseHistoryMessage({ type: "select", revision: 1, oids, focusedOid: null });

    oids.push(SHA256_OID);

    expect(message).toEqual({ type: "select", revision: 1, oids: [OID], focusedOid: null });
  });

  it.each([null, undefined, "ready", 7, [], [{ type: "ready", revision: 1 }]])("rejects the non-message %j", (value) => {
    expect(parseHistoryMessage(value)).toBeNull();
  });

  it.each([
    ["an unknown type", { type: "resolve", revision: 1 }],
    ["an inherited type name", { type: "toString", revision: 1 }],
    ["a missing revision", { type: "refresh" }],
    ["a missing field", { type: "openFile", revision: 1, snapshotId: SNAPSHOT_ID }],
    ["an extra field", { type: "refresh", revision: 1, path: "/etc/passwd" }],
  ])("rejects %s", (_name, value) => {
    expect(parseHistoryMessage(value)).toBeNull();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, Number.MAX_SAFE_INTEGER + 1])("rejects revision %s", (revision) => {
    expect(parseHistoryMessage({ type: "ready", revision })).toBeNull();
  });

  it.each([
    ["short", "abc123"],
    ["uppercase", "A".repeat(40)],
    ["non-hex", "g".repeat(40)],
    ["between lengths", "a".repeat(41)],
    ["a symbolic ref", "HEAD"],
    ["a number", 1234],
  ])("rejects a %s commit ID", (_name, oid) => {
    expect(parseHistoryMessage({ type: "select", revision: 1, oids: [OID, oid], focusedOid: null })).toBeNull();
    expect(parseHistoryMessage({ type: "select", revision: 1, oids: [], focusedOid: oid })).toBeNull();
    expect(parseHistoryMessage({ type: "mainline", revision: 1, oid, parentNumber: 1 })).toBeNull();
  });

  it("rejects a selection that repeats a commit", () => {
    expect(parseHistoryMessage({ type: "select", revision: 1, oids: [OID, SHA256_OID, OID], focusedOid: null })).toBeNull();
  });

  it.each(["main\u0000", "main\nHEAD", "\u007f"])("rejects the base ref %j with control characters", (ref) => {
    expect(parseHistoryMessage({ type: "base", revision: 1, ref })).toBeNull();
  });

  it("rejects a selection that is not an array", () => {
    expect(parseHistoryMessage({ type: "select", revision: 1, oids: OID, focusedOid: null })).toBeNull();
  });

  it.each([0, -1, 1.5, "2", Number.NaN, null])("rejects merge parent %s", (parentNumber) => {
    expect(parseHistoryMessage({ type: "mainline", revision: 1, oid: OID, parentNumber })).toBeNull();
  });

  it.each(["../../etc/passwd", "/tmp/file", "C:\\file", `${FILE_ID}/..`, FILE_ID.toUpperCase(), ""])(
    "rejects the path-like or malformed file ID %j",
    (fileId) => {
      expect(parseHistoryMessage({ type: "openFile", revision: 1, snapshotId: SNAPSHOT_ID, fileId })).toBeNull();
      expect(parseHistoryMessage({ type: "openFile", revision: 1, snapshotId: fileId, fileId: FILE_ID })).toBeNull();
      expect(parseHistoryMessage({ type: "repository", revision: 1, repositoryId: fileId })).toBeNull();
    },
  );

  it("bounds search text and base refs", () => {
    const longest = "x".repeat(MAX_HISTORY_TEXT_LENGTH);
    const tooLong = `${longest}x`;
    const presentation = { type: "presentation", revision: 1, branchOid: null, focusedOid: null, rowLimit: 200 };

    expect(parseHistoryMessage({ ...presentation, search: longest })).not.toBeNull();
    expect(parseHistoryMessage({ ...presentation, search: tooLong })).toBeNull();
    expect(parseHistoryMessage({ type: "base", revision: 1, ref: longest })).not.toBeNull();
    expect(parseHistoryMessage({ type: "base", revision: 1, ref: tooLong })).toBeNull();
  });

  it.each(["", "   ", 42, false])("rejects the base ref %j", (ref) => {
    expect(parseHistoryMessage({ type: "base", revision: 1, ref })).toBeNull();
  });

  it.each([
    ["a string boolean search", { search: "true" }, true],
    ["a numeric search", { search: 1 }, false],
    ["a branch name instead of an OID", { branchOid: "main" }, false],
    ["an empty-string branch", { branchOid: "" }, false],
    ["a zero row limit", { rowLimit: 0 }, false],
    ["a fractional row limit", { rowLimit: 200.5 }, false],
    ["a string row limit", { rowLimit: "200" }, false],
    ["a leftover scroll offset", { scrollTop: 0 }, false],
  ])("validates presentation with %s", (_name, override, isAccepted) => {
    const message = { type: "presentation", revision: 1, search: "", branchOid: null, focusedOid: null, rowLimit: 200, ...override };

    expect(parseHistoryMessage(message) !== null).toBe(isAccepted);
  });

  it("lets no malformed message reach the dispatcher", () => {
    const handle = vi.fn();
    const malformed: readonly unknown[] = [
      { type: "openFile", revision: 1, snapshotId: SNAPSHOT_ID, fileId: "../secret" },
      { type: "select", revision: "1", oids: [OID], focusedOid: null },
      { type: "mainline", revision: 1, oid: OID, parentNumber: 0 },
      { type: "deleteEverything", revision: 1 },
      null,
    ];

    for (const value of malformed) {
      dispatch(value, handle);
    }
    dispatch({ type: "refresh", revision: 2 }, handle);

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith({ type: "refresh", revision: 2 });
  });
});
