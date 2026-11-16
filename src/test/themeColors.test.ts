import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

interface ColorContribution {
  readonly id: string;
  readonly description: string;
  readonly defaults: { readonly dark: string; readonly light: string; readonly highContrast: string };
}

interface Manifest {
  readonly contributes: { readonly colors: readonly ColorContribution[] };
}

const root = path.join(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Manifest;
const stylesheets = ["diff.css", "merge.css"].map((name) => fs.readFileSync(path.join(root, "media", name), "utf8"));
const colors = manifest.contributes.colors;

/** A webview sees colour `a.b` as `--vscode-a-b`; VS Code replaces only the first dot. */
function cssVariable(colorId: string): string {
  return `--vscode-${colorId.replace(".", "-")}`;
}

function declarations(css: string, pattern: RegExp): string[] {
  return [...css.matchAll(pattern)].map((match) => match[1]);
}

describe("themable change colours", () => {
  it("contributes ids the webview can expose as CSS variables", () => {
    for (const color of colors) {
      expect(color.id).toMatch(/^jwDiffer\.[A-Za-z]+$/);
      expect(color.description).not.toBe("");
    }
  });

  it("feeds each contributed colour into the stylesheets with its dark default as the fallback", () => {
    const css = stylesheets.join("\n");

    for (const color of colors) {
      expect(css).toContain(`var(${cssVariable(color.id)}, ${color.defaults.dark})`);
    }
  });

  it("references only contributed colours from the extension's namespace", () => {
    const contributed = colors.map((color) => cssVariable(color.id));
    const referenced = stylesheets.flatMap((css) => declarations(css, /var\((--vscode-jwDiffer-[\w-]+)/g));

    expect(referenced.length).toBeGreaterThan(0);
    expect(contributed).toEqual(expect.arrayContaining(referenced));
  });

  it("hard-codes no change colour, so no theme block overrides the user's", () => {
    const values = stylesheets.flatMap((css) => declarations(css, /--chg-[\w-]+:\s*([^;]+);/g));

    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toMatch(/^var\(--(vscode-jwDiffer|chg)-/);
    }
  });
});
