import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.join(__dirname, "..");

function sourcesUnder(directory: string): string[] {
  const root = path.join(SOURCE_ROOT, directory);
  if (!fs.existsSync(root)) {
    return [];
  }

  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => fs.readFileSync(path.join(root, entry), "utf8"));
}

/**
 * These boundaries are what makes a second renderer — a terminal UI — possible
 * without touching the merge logic, so they are asserted rather than assumed.
 */
describe("layering", () => {
  it.each(["core", "git", "model", "render"])("keeps the vscode API out of src/%s", (layer) => {
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

  it("keeps the core diff engine free of git and host concerns", () => {
    for (const source of sourcesUnder("core")) {
      expect(source).not.toMatch(/from "\.\.\/(git|model|render|host)/);
    }
  });
});
