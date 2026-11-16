import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

interface IdEntry {
  readonly id: string;
}

interface Contributes {
  readonly commands: readonly { readonly command: string }[];
  readonly viewsContainers: Readonly<Record<string, readonly IdEntry[]>>;
  readonly views: Readonly<Record<string, readonly IdEntry[]>>;
  readonly colors: readonly IdEntry[];
  readonly configuration: { readonly properties: Readonly<Record<string, unknown>> };
}

const root = path.join(__dirname, "..", "..");
const contributes = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { contributes: Contributes }).contributes;
const mediaDirectory = path.join(root, "media");

/** Every id the manifest contributes: commands, view containers, views, colours and settings. */
function contributedIds(): string[] {
  return [
    ...contributes.commands.map((command) => command.command),
    ...Object.values(contributes.viewsContainers).flat().map((container) => container.id),
    ...Object.values(contributes.views).flat().map((view) => view.id),
    ...contributes.colors.map((color) => color.id),
    ...Object.keys(contributes.configuration.properties),
  ];
}

describe("extension namespace", () => {
  it("contributes every id under the jwDiffer prefix", () => {
    const ids = contributedIds();

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toMatch(/^jwDiffer[.A-Z]/);
    }
  });

  it("leaves no id, context key or when clause under the old differ. prefix", () => {
    expect(JSON.stringify(contributes)).not.toMatch(/(?<![\w-])differ\./);
  });

  it("reads no colour through the old --vscode-differ- variables", () => {
    const stylesheets = fs.readdirSync(mediaDirectory).filter((name) => name.endsWith(".css"));

    expect(stylesheets.length).toBeGreaterThan(0);
    for (const name of stylesheets) {
      expect(fs.readFileSync(path.join(mediaDirectory, name), "utf8")).not.toContain("--vscode-differ-");
    }
  });
});
