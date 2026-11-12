import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { HighlightOptions } from "../highlight/textMateHighlighter";
import { TwoWayDiffPanels, type TextHighlighter, type TwoWayDiffRequest } from "../host/vscode/twoWayDiffPanel";
import type { HighlightedText } from "../model/syntaxTokens";
import { ColorThemeKind, changeColorThemeKind, changeConfiguration, resetVscodeMock, vscodeMock, type FakeWebviewPanel } from "./vscodeMock";

const MEDIA_ROOT = vscode.Uri.file("/extension/media");
const BLUE: HighlightedText = { styles: [{ color: "#0000ff", fontStyle: 0 }], lines: [[{ length: 3, styleIndex: 0 }], [{ length: 0, styleIndex: 0 }]] };
const RED: HighlightedText = { styles: [{ color: "#ff0000", fontStyle: 0 }], lines: BLUE.lines };

interface RecordingHighlighter extends TextHighlighter {
  readonly calls: { readonly text: string; readonly languageId: string }[];
  readonly options: (HighlightOptions | undefined)[];
}

function highlighter(highlight: (text: string) => Promise<HighlightedText>): RecordingHighlighter {
  const calls: { text: string; languageId: string }[] = [];
  const options: (HighlightOptions | undefined)[] = [];
  return {
    calls,
    options,
    highlight: (text, languageId, highlightOptions) => {
      calls.push({ text, languageId });
      options.push(highlightOptions);
      return highlight(text);
    },
  };
}

interface Deferred {
  readonly promise: Promise<HighlightedText>;
  readonly resolve: (highlight: HighlightedText) => void;
}

function deferred(): Deferred {
  let resolve: (highlight: HighlightedText) => void = () => undefined;
  const promise = new Promise<HighlightedText>((finish) => (resolve = finish));
  return { promise, resolve };
}

/** Lets pending promise callbacks and `setImmediate` work run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A side whose label throws, so rendering fails after highlighting succeeded. */
function unrenderable(side: TwoWayDiffRequest["base"]): TwoWayDiffRequest["base"] {
  return {
    uri: side.uri,
    text: side.text,
    path: side.path,
    get label(): string {
      throw new Error("render broke");
    },
  };
}

function request(changes: Partial<TwoWayDiffRequest> = {}): TwoWayDiffRequest & { nativeOpens: number; releases: number } {
  const result = {
    title: "app.ts (1807da6c ↔ 2 selected commits)",
    base: { uri: vscode.Uri.from({ scheme: "differ-history", path: "/b/src/app.ts" }), text: "old\n", label: "1807da6c", path: "src/app.ts" },
    result: { uri: vscode.Uri.from({ scheme: "differ-history", path: "/r/src/app.ts" }), text: "new\n", label: "2 selected commits", path: "src/app.ts" },
    languageUri: vscode.Uri.from({ scheme: "differ-history", path: "/r/src/app.ts" }),
    nativeOpens: 0,
    releases: 0,
    openNative: () => {
      result.nativeOpens += 1;
      return Promise.resolve();
    },
    release: () => void (result.releases += 1),
    ...changes,
  };
  return result;
}

function onlyPanel(): FakeWebviewPanel {
  expect(vscodeMock.webviewPanels).toHaveLength(1);
  return vscodeMock.webviewPanels[0];
}

describe("TwoWayDiffPanels", () => {
  let logged: string[];

  beforeEach(() => {
    resetVscodeMock();
    vscodeMock.languageIds.set(".ts", "typescript");
    logged = [];
  });

  afterEach(() => vi.useRealTimers());

  function panels(textHighlighter: TextHighlighter): TwoWayDiffPanels {
    return new TwoWayDiffPanels({ mediaRoot: MEDIA_ROOT, highlighter: textHighlighter, log: (message) => logged.push(message) });
  }

  it("opens an active editor panel with scripts limited to the media folder", async () => {
    await panels(highlighter(() => Promise.resolve(BLUE))).open(request());

    const panel = onlyPanel();
    expect(panel.viewType).toBe("differ.twoWayDiff");
    expect(panel.title).toBe("app.ts (1807da6c ↔ 2 selected commits)");
    expect(panel.showOptions).toEqual({ viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
    expect(panel.options.enableScripts).toBe(true);
    expect(panel.options.localResourceRoots).toEqual([MEDIA_ROOT]);
  });

  it("renders both sides with a nonce-guarded content security policy", async () => {
    await panels(highlighter(() => Promise.resolve(BLUE))).open(request());

    const html = onlyPanel().webview.html;
    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/=_-]{16,}$/);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`<script nonce="${nonce}" src="vscode-webview-resource:/extension/media/diff.js"`);
    expect(html).toContain("vscode-webview-resource:/extension/media/diff.css");
    expect(html).toContain("1807da6c");
    expect(html).toContain("2 selected commits");
    expect(html).toContain("1 difference");
  });

  it("highlights both sides in the language VS Code assigns the language document", async () => {
    const recording = highlighter(() => Promise.resolve(BLUE));

    await panels(recording).open(request());

    expect(recording.calls).toEqual([{ text: "old\n", languageId: "typescript" }, { text: "new\n", languageId: "typescript" }]);
    expect(onlyPanel().webview.html).toContain("#0000ff");
  });

  it("falls back to unstyled text and logs when highlighting fails", async () => {
    await panels(highlighter(() => Promise.reject(new Error("grammar broke")))).open(request());

    const html = onlyPanel().webview.html;
    expect(html).toContain("old");
    expect(html).not.toContain("#0000ff");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("grammar broke");
  });

  it("opens the native diff when the webview asks", async () => {
    const opened = request();
    await panels(highlighter(() => Promise.resolve(BLUE))).open(opened);

    onlyPanel().webview.fireDidReceiveMessage({ type: "ready" });
    onlyPanel().webview.fireDidReceiveMessage({ type: "openNative" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(opened.nativeOpens).toBe(1);
  });

  it("reports a failed native diff instead of rejecting", async () => {
    const opened = request({ openNative: () => Promise.reject(new Error("no editor")) });
    await panels(highlighter(() => Promise.resolve(BLUE))).open(opened);

    onlyPanel().webview.fireDidReceiveMessage({ type: "openNative" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(vscodeMock.messages).toEqual([{ level: "error", text: "Differ could not open the VS Code diff editor." }]);
    expect(logged[0]).toContain("no editor");
  });

  it("releases its documents once when the panel closes", async () => {
    const opened = request();
    await panels(highlighter(() => Promise.resolve(BLUE))).open(opened);

    onlyPanel().dispose();
    onlyPanel().webview.fireDidReceiveMessage({ type: "openNative" });

    expect(opened.releases).toBe(1);
    expect(opened.nativeOpens).toBe(0);
  });

  it("reuses one tab for the next file, like VS Code's preview diff, and releases the file it replaced", async () => {
    const first = request();
    const second = request({ title: "util.ts (1807da6c ↔ 2 selected commits)" });
    const diffPanels = panels(highlighter(() => Promise.resolve(BLUE)));
    await diffPanels.open(first);

    await diffPanels.open(second);

    const panel = onlyPanel();
    expect(panel.title).toBe("util.ts (1807da6c ↔ 2 selected commits)");
    expect(panel.revealCount).toBe(1);
    expect([first.releases, second.releases]).toEqual([1, 0]);
  });

  it("sends the native-diff request for the file the reused tab currently shows", async () => {
    const first = request();
    const second = request();
    const diffPanels = panels(highlighter(() => Promise.resolve(BLUE)));
    await diffPanels.open(first);
    await diffPanels.open(second);

    onlyPanel().webview.fireDidReceiveMessage({ type: "openNative" });
    await new Promise((resolve) => setImmediate(resolve));

    expect([first.nativeOpens, second.nativeOpens]).toEqual([0, 1]);
  });

  it("closes every open panel on dispose", async () => {
    const first = request();
    const second = request();
    const diffPanels = panels(highlighter(() => Promise.resolve(BLUE)));
    await diffPanels.open(first);
    await diffPanels.open(second);

    diffPanels.dispose();

    expect(vscodeMock.webviewPanels.every((panel) => panel.isDisposed)).toBe(true);
    expect([first.releases, second.releases]).toEqual([1, 1]);
  });

  it("opens nothing and releases the request when disposed while highlighting", async () => {
    const pending: ((highlight: HighlightedText) => void)[] = [];
    const diffPanels = panels(highlighter(() => new Promise((resolve) => pending.push(resolve))));
    const opened = request();
    const opening = diffPanels.open(opened);
    await new Promise((resolve) => setImmediate(resolve));

    diffPanels.dispose();
    pending.forEach((finish) => finish(BLUE));
    await opening;

    expect(vscodeMock.webviewPanels).toEqual([]);
    expect(opened.releases).toBe(1);
  });

  it("shows the latest file when an earlier open finishes highlighting after it", async () => {
    const pending = new Map<string, Deferred>();
    const recording = highlighter((text) => {
      const highlight = deferred();
      pending.set(text, highlight);
      return highlight.promise;
    });
    const diffPanels = panels(recording);
    const first = request();
    const second = request({ title: "util.ts", base: { ...request().base, text: "two-old\n" }, result: { ...request().result, text: "two-new\n" } });
    const openingFirst = diffPanels.open(first);
    const openingSecond = diffPanels.open(second);
    await settle();

    ["two-old\n", "two-new\n"].forEach((text) => pending.get(text)?.resolve(BLUE));
    await openingSecond;
    ["old\n", "new\n"].forEach((text) => pending.get(text)?.resolve(BLUE));
    await openingFirst;

    expect(onlyPanel().title).toBe("util.ts");
    expect([first.releases, second.releases]).toEqual([1, 0]);
    expect(recording.options[0]?.signal?.aborted).toBe(true);
    expect(recording.options[2]?.signal?.aborted).toBe(false);
  });

  it("shares one tokenizing deadline between both sides", async () => {
    const recording = highlighter(() => Promise.resolve(BLUE));

    await panels(recording).open(request());

    expect(recording.options[0]?.deadline).toBeGreaterThan(0);
    expect(recording.options[0]).toBe(recording.options[1]);
  });

  it("shows plain text and logs once when highlighting never finishes", async () => {
    vi.useFakeTimers();
    const recording = highlighter(() => new Promise<HighlightedText>(() => undefined));
    const opening = panels(recording).open(request());

    await vi.advanceTimersByTimeAsync(3_000);
    await opening;

    const html = onlyPanel().webview.html;
    expect(html).toContain("old");
    expect(html).not.toContain("#0000ff");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("timed out");
    expect(recording.options[0]?.signal?.aborted).toBe(true);
  });

  it("re-highlights the shown file when the colour theme or token colours change", async () => {
    let colors = BLUE;
    const recording = highlighter(() => Promise.resolve(colors));
    const diffPanels = panels(recording);
    const opened = request();
    await diffPanels.open(opened);

    colors = RED;
    changeColorThemeKind(ColorThemeKind.Light);
    await vi.waitFor(() => expect(onlyPanel().webview.html).toContain("#ff0000"));
    colors = BLUE;
    changeConfiguration("editor.tokenColorCustomizations", { textMateRules: [] });
    await vi.waitFor(() => expect(onlyPanel().webview.html).toContain("#0000ff"));

    expect(recording.calls).toHaveLength(6);
    expect(opened.releases).toBe(0);
  });

  it("ignores unrelated and theme-name setting changes, and colour changes once disposed", async () => {
    const recording = highlighter(() => Promise.resolve(BLUE));
    const diffPanels = panels(recording);
    await diffPanels.open(request());

    changeConfiguration("differ.wordLevelHighlighting", false);
    // The active-theme event, not the setting, reports a theme switch.
    changeConfiguration("workbench.colorTheme", "Default Light Modern");
    diffPanels.dispose();
    changeColorThemeKind(ColorThemeKind.Light);
    await settle();

    expect(recording.calls).toHaveLength(2);
  });

  it("closes a new tab and releases the request exactly once when rendering fails", async () => {
    const opened = request();
    const failing = { ...opened, base: unrenderable(opened.base) };

    await expect(panels(highlighter(() => Promise.resolve(BLUE))).open(failing)).rejects.toThrow("render broke");

    expect(onlyPanel().isDisposed).toBe(true);
    expect(opened.releases).toBe(1);
  });

  it("keeps the shown file when rendering the next one fails, releasing only the failed request", async () => {
    const first = request();
    const second = request({ title: "util.ts" });
    const failing = { ...second, base: unrenderable(second.base) };
    const diffPanels = panels(highlighter(() => Promise.resolve(BLUE)));
    await diffPanels.open(first);

    await expect(diffPanels.open(failing)).rejects.toThrow("render broke");

    expect(onlyPanel().title).toBe("app.ts (1807da6c ↔ 2 selected commits)");
    expect(onlyPanel().isDisposed).toBe(false);
    expect([first.releases, second.releases]).toEqual([0, 1]);
  });

  it("re-highlights a file whose highlighting started before a colour change once it is shown", async () => {
    const pending: Deferred[] = [];
    const recording = highlighter(() => {
      const highlight = deferred();
      pending.push(highlight);
      return highlight.promise;
    });
    const opening = panels(recording).open(request());
    await settle();

    changeColorThemeKind(ColorThemeKind.Light);
    pending.forEach((highlight) => highlight.resolve(BLUE));
    await opening;
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending.slice(2).forEach((highlight) => highlight.resolve(RED));

    await vi.waitFor(() => expect(onlyPanel().webview.html).toContain("#ff0000"));
  });

  it("drops a colour refresh when another file replaced the shown one meanwhile", async () => {
    const pending = new Map<string, Deferred>();
    const recording = highlighter((text) => {
      const highlight = deferred();
      pending.set(text, highlight);
      return highlight.promise;
    });
    const diffPanels = panels(recording);
    const first = request();
    const opening = diffPanels.open(first);
    await settle();
    ["old\n", "new\n"].forEach((text) => pending.get(text)?.resolve(BLUE));
    await opening;

    changeColorThemeKind(ColorThemeKind.Light);
    await settle();
    const refreshSignal = recording.options[2]?.signal;
    const second = request({ title: "util.ts", base: { ...first.base, text: "two-old\n" }, result: { ...first.result, text: "two-new\n" } });
    const openingSecond = diffPanels.open(second);
    await settle();
    ["two-old\n", "two-new\n"].forEach((text) => pending.get(text)?.resolve(BLUE));
    await openingSecond;
    ["old\n", "new\n"].forEach((text) => pending.get(text)?.resolve(RED));
    await settle();

    expect(refreshSignal?.aborted).toBe(true);
    expect(onlyPanel().title).toBe("util.ts");
    expect(onlyPanel().webview.html).not.toContain("#ff0000");
    expect([first.releases, second.releases]).toEqual([1, 0]);
  });

  it("leaves no highlight timer behind once highlighting finished", async () => {
    vi.useFakeTimers();

    await panels(highlighter(() => Promise.resolve(BLUE))).open(request());

    expect(vi.getTimerCount()).toBe(0);
  });
});
