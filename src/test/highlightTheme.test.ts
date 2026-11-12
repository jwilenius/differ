import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_FOREGROUND_PLACEHOLDER, normalizeColor, resolveTextMateTheme } from "../highlight/themeResolver";

const THEMES = path.join(__dirname, "fixtures", "highlight", "themes");

describe("resolveTextMateTheme", () => {
  it("orders the include chain first, the including theme next and customizations last", async () => {
    const customRules = [{ scope: "keyword", settings: { foreground: "#123456" } }];

    const result = await resolveTextMateTheme(path.join(THEMES, "nested", "top.json"), customRules);

    expect(result.problems).toEqual([]);
    expect(result.theme.settings).toEqual([
      { settings: { foreground: DEFAULT_FOREGROUND_PLACEHOLDER } },
      { scope: "comment", settings: { foreground: "#6A9955", fontStyle: "italic" } },
      { scope: "keyword", settings: { foreground: "#569CD6" } },
      { scope: "string", settings: { foreground: "#CE9178" } },
      { scope: "keyword.todo", settings: { foreground: "#FF0000", fontStyle: "bold" } },
      { scope: "string", settings: { foreground: "#AABBCC" } },
      { scope: ["constant.numeric"], settings: { foreground: "#B5CEA8" } },
      { scope: "keyword", settings: { foreground: "#123456" } },
    ]);
  });

  it("drops malformed customization rules", async () => {
    const customRules = [null, { scope: "" , settings: {} }, { scope: "x" }, { scope: "y", settings: { foreground: "red" } }];

    const result = await resolveTextMateTheme(path.join(THEMES, "base.json"), customRules);

    expect(result.theme.settings.at(-1)).toEqual({ scope: "y", settings: {} });
  });

  it("reports include cycles and unsupported tmTheme token colors but keeps the readable rules", async () => {
    const result = await resolveTextMateTheme(path.join(THEMES, "cycle-a.json"), []);

    expect(result.theme.settings).toEqual([
      { settings: { foreground: DEFAULT_FOREGROUND_PLACEHOLDER } },
      { scope: "keyword", settings: { foreground: "#111111" } },
    ]);
    expect(result.problems).toEqual([
      `Theme include cycle at ${path.join(THEMES, "cycle-a.json")}`,
      `Token colors ${path.join(THEMES, "colors.tmTheme")} are not JSON; .tmTheme files are not supported`,
    ]);
  });

  it("reports a tmTheme colour theme as unsupported", async () => {
    const themePath = path.join(THEMES, "classic.tmTheme");

    const result = await resolveTextMateTheme(themePath, []);

    expect(result.theme.settings).toEqual([{ settings: { foreground: DEFAULT_FOREGROUND_PLACEHOLDER } }]);
    expect(result.problems).toEqual([`Theme ${themePath}: tmTheme themes are not supported`]);
  });

  it("reports a missing theme file and still yields the default rule", async () => {
    const result = await resolveTextMateTheme(path.join(THEMES, "missing.json"), []);

    expect(result.theme.settings).toEqual([{ settings: { foreground: DEFAULT_FOREGROUND_PLACEHOLDER } }]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("Cannot read");
  });
});

describe("normalizeColor", () => {
  it.each([
    ["#abc", "#AABBCC"],
    ["#abcd", "#AABBCCDD"],
    ["#a1b2c3", "#A1B2C3"],
    ["#a1b2c3ff", "#A1B2C3"],
    ["#a1b2c380", "#A1B2C380"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeColor(input)).toBe(expected);
  });

  it.each(["red", "#ab", "#ggg", "", 42, undefined])("rejects %s", (input) => {
    expect(normalizeColor(input)).toBeUndefined();
  });
});
