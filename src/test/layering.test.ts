import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.join(__dirname, "..");

/** Contents of the `.ts` files under `src/<directory>` whose relative path matches `filter`. */
function sourcesUnder(directory: string, filter = /\.ts$/): string[] {
  const root = path.join(SOURCE_ROOT, directory);
  if (!fs.existsSync(root)) {
    return [];
  }

  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && filter.test(entry))
    .map((entry) => fs.readFileSync(path.join(root, entry), "utf8"));
}

/**
 * These boundaries are what makes a second renderer — a terminal UI — possible
 * without touching the merge logic, so they are asserted rather than assumed.
 */
describe("layering", () => {
  it.each(["core", "git", "highlight", "model", "render"])("keeps the vscode API out of src/%s", (layer) => {
    for (const source of sourcesUnder(layer)) {
      expect(source).not.toMatch(/from "vscode"|require\("vscode"\)/);
    }
  });

  it.each(["core", "git", "model"])("keeps markup out of src/%s", (layer) => {
    for (const source of sourcesUnder(layer)) {
      expect(source).not.toMatch(/<!DOCTYPE|<div|<span/);
    }
  });

  it("keeps the model independent of any renderer", () => {
    for (const source of sourcesUnder("model")) {
      expect(source).not.toMatch(/from "\.\.\/render/);
    }
  });

  it("keeps Node filesystem, subprocess and host APIs out of the model", () => {
    for (const source of sourcesUnder("model")) {
      expect(source).not.toMatch(/from "(node:)?(fs|fs\/promises|child_process)"|require\("(node:)?(fs|child_process)/);
      expect(source).not.toMatch(/from "\.\.\/host/);
    }
  });

  it("keeps the history model free of Git adapters and Node-only types", () => {
    const sources = sourcesUnder("model", /^history/);

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).not.toMatch(/from "node:|from "\.\.\/git|\bBuffer\b/);
    }
  });

  it("keeps the two-way diff model and renderer free of Node-only APIs", () => {
    const sources = [...sourcesUnder("model", /^twoWayDiff/), ...sourcesUnder("render", /twoWayDiff/)];

    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source).not.toMatch(/from "node:|require\("|\bBuffer\b/);
    }
  });

  it.each(["git", "render"])("keeps host code out of src/%s", (layer) => {
    for (const source of sourcesUnder(layer)) {
      expect(source).not.toMatch(/from "\.\.\/(\.\.\/)?host/);
    }
  });

  it("keeps the highlighting engine free of host and renderer code", () => {
    const sources = sourcesUnder("highlight");

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).not.toMatch(/from "\.\.\/(host|render)/);
    }
  });

  it("keeps the core diff engine free of git and host concerns", () => {
    for (const source of sourcesUnder("core")) {
      expect(source).not.toMatch(/from "\.\.\/(git|model|render|host)/);
    }
  });
});
