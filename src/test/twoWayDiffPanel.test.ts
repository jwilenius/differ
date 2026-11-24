import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { HighlightOptions } from "../highlight/textMateHighlighter";
import { TwoWayDiffPanels, type AdjacentFiles, type TextHighlighter, type TwoWayDiffRequest } from "../host/vscode/twoWayDiffPanel";
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

/** A diff in a file list whose neighbouring files are found at once. */
function inList(adjacentFiles: AdjacentFiles): Pick<TwoWayDiffRequest, "findAdjacentFiles"> {
  return { findAdjacentFiles: () => Promise.resolve(adjacentFiles) };
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
    base: { uri: vscode.Uri.from({ scheme: "jw-differ-history", path: "/b/src/app.ts" }), text: "old\n", label: "1807da6c", path: "src/app.ts" },
    result: { uri: vscode.Uri.from({ scheme: "jw-differ-history", path: "/r/src/app.ts" }), text: "new\n", label: "2 selected commits", path: "src/app.ts" },
    languageUri: vscode.Uri.from({ scheme: "jw-differ-history", path: "/r/src/app.ts" }),
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

/** The number of the diff page the panel shows, which its script stamps on every message. */
function shownPage(): number {
  return Number(/id="diff" data-page="(\d+)"/.exec(onlyPanel().webview.html)?.[1]);
}

/** Delivers a message as the diff page the panel shows posts it. */
function post(message: Readonly<Record<string, unknown>>): void {
  onlyPanel().webview.fireDidReceiveMessage({ ...message, page: shownPage() });
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
    expect(panel.viewType).toBe("jwDiffer.twoWayDiff");
    expect(panel.title).toBe("app.ts (1807da6c ↔ 2 selected commits)");
    expect(panel.showOptions).toEqual({ viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
    expect(panel.options.enableScripts).toBe(true);
    expect(panel.options.localResourceRoots).toEqual([MEDIA_ROOT]);
  });

  it("offers VS Code's find widget, so Ctrl+F searches both sides of the diff", async () => {
    await panels(highlighter(() => Promise.resolve(BLUE))).open(request());

    expect(onlyPanel().options.enableFindWidget).toBe(true);
  });

  it("renders both sides with a nonce-guarded content security policy", async () => {
    await panels(highlighter(() => Promise.resolve(BLUE))).open(request());

    const html = onlyPanel().webview.html;
    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/=_-]{16,}$/);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`<script nonce="${nonce}" src="vscode-webview-resource:/extension/media/diffGeometry.js"`);
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

  it("highlights a deleted file in the language VS Code gives its name", async () => {
    vscodeMock.openFileDocument = (uri) => {
      throw new Error(`Unable to resolve nonexistent file '${uri.fsPath}'`);
    };
    const recording = highlighter(() => Promise.resolve(BLUE));

    await panels(recording).open(request({ languageUri: vscode.Uri.file("/repo/src/gone.ts") }));

    expect(recording.calls.map((call) => call.languageId)).toEqual(["typescript", "typescript"]);
    expect(logged).toEqual([]);
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

    post({ type: "ready" });
    post({ type: "openNative" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(opened.nativeOpens).toBe(1);
  });

  it("reports a failed native diff instead of rejecting", async () => {
    const opened = request({ openNative: () => Promise.reject(new Error("no editor")) });
    await panels(highlighter(() => Promise.resolve(BLUE))).open(opened);

    post({ type: "openNative" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(vscodeMock.messages).toEqual([{ level: "error", text: "jw-differ could not open the VS Code diff editor." }]);
    expect(logged[0]).toContain("no editor");
  });

  it("shows a diff in a file list at once and sends its neighbouring files once they are found", async () => {
    let finish: (adjacentFiles: AdjacentFiles) => void = () => undefined;
    const opened = request({ findAdjacentFiles: () => new Promise((resolve) => (finish = resolve)), startAt: "last" });

    await panels(highlighter(() => Promise.resolve(BLUE))).open(opened);

    const webview = onlyPanel().webview;
    expect(webview.html).toContain(`data-files="{&quot;hasPrevious&quot;:false,&quot;hasNext&quot;:false,&quot;isPending&quot;:true}"`);
    expect(webview.html).toContain(`data-start-at="last"`);
    expect(webview.postedSinceHtml).toEqual([]);

    finish({ next: () => Promise.resolve() });
    await settle();

    expect(webview.postedSinceHtml).toEqual([{ type: "fileList", page: shownPage(), hasPrevious: false, hasNext: true }]);
  });

  it("redraws a diff in new colours with the neighbouring files found", async () => {
    let colors = BLUE;
    await panels(highlighter(() => Promise.resolve(colors))).open(request(inList({ next: () => Promise.resolve() })));
    await settle();

    colors = RED;
    changeColorThemeKind(ColorThemeKind.Light);
    await vi.waitFor(() => expect(onlyPanel().webview.html).toContain("#ff0000"));

    expect(onlyPanel().webview.html).toContain(`data-files="{&quot;hasPrevious&quot;:false,&quot;hasNext&quot;:true}"`);
  });

  it("ignores a file step asked for before the neighbouring files are found", async () => {
    const opened: string[] = [];
    let finish: (adjacentFiles: AdjacentFiles) => void = () => undefined;
    const next = () => {
      opened.push("next");
      return Promise.resolve();
    };
    await panels(highlighter(() => Promise.resolve(BLUE))).open(request({ findAdjacentFiles: () => new Promise((resolve) => (finish = resolve)) }));

    post({ type: "openAdjacentFile", direction: "next" });
    finish({ next });
    await settle();
    expect(opened).toEqual([]);

    post({ type: "openAdjacentFile", direction: "next" });
    await settle();
    expect(opened).toEqual(["next"]);
  });

  it("drops the neighbouring files found for a diff the tab no longer shows", async () => {
    const opened: string[] = [];
    let finishFirst: (adjacentFiles: AdjacentFiles) => void = () => undefined;
    const diffPanels = panels(highlighter(() => Promise.resolve(BLUE)));
    await diffPanels.open(request({ findAdjacentFiles: () => new Promise((resolve) => (finishFirst = resolve)) }));
    await diffPanels.open(request(inList({})));
    await settle();
    const webview = onlyPanel().webview;
    const posted = webview.postedSinceHtml.length;

    finishFirst({
      next: () => {
        opened.push("after first");
        return Promise.resolve();
      },
    });
    await settle();
    post({ type: "openAdjacentFile", direction: "next" });
    await settle();

    expect(webview.postedSinceHtml).toHaveLength(posted);
    expect(opened).toEqual([]);
  });

  it("ends the search for a diff's neighbouring files once the tab moves on or closes", async () => {
    const signals: AbortSignal[] = [];
    const finding = (): Pick<TwoWayDiffRequest, "findAdjacentFiles"> => ({
      findAdjacentFiles: (signal) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
    });
    const diffPanels = panels(highlighter(() => Promise.resolve(BLUE)));
    await diffPanels.open(request(finding()));
    expect(signals.map((signal) => signal.aborted)).toEqual([false]);

    await diffPanels.open(request(finding()));
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);

    onlyPanel().dispose();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  it("offers no file step when finding the neighbouring files fails", async () => {
    await panels(highlighter(() => Promise.resolve(BLUE))).open(request({ findAdjacentFiles: () => Promise.reject(new Error("list broke")) }));
    await settle();

    expect(onlyPanel().webview.postedSinceHtml).toEqual([{ type: "fileList", page: shownPage(), hasPrevious: false, hasNext: false }]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("list broke");
  });

  it("publishes no file list for a diff without one", async () => {
    await panels(highlighter(() => Promise.resolve(BLUE))).open(request());

    expect(onlyPanel().webview.html).not.toContain("data-files");
  });

  it("opens the next or previous file when the webview asks", async () => {
    const opened: string[] = [];
    const record = (direction: string) => () => {
      opened.push(direction);
      return Promise.resolve();
    };
    await panels(highlighter(() => Promise.resolve(BLUE))).open(request(inList({ previous: record("previous"), next: record("next") })));
    await settle();

    post({ type: "openAdjacentFile", direction: "next" });
    post({ type: "openAdjacentFile", direction: "previous" });
    post({ type: "openAdjacentFile", direction: "sideways" });
    await settle();

    expect(opened).toEqual(["next", "previous"]);
  });

  it("drops a message the page of a replaced diff sent, so its step never moves on from the shown file", async () => {
    const opened: string[] = [];
    const record = (name: string) => () => {
      opened.push(name);
      return Promise.resolve();
    };
    const diffPanels = panels(highlighter(() => Promise.resolve(BLUE)));
    await diffPanels.open(request(inList({ next: record("after first") })));
    const firstPage = shownPage();
    await diffPanels.open(request(inList({ next: record("after second") })));
    await settle();

    onlyPanel().webview.fireDidReceiveMessage({ type: "openAdjacentFile", direction: "next", page: firstPage });
    onlyPanel().webview.fireDidReceiveMessage({ type: "openAdjacentFile", direction: "next" });
    await settle();
    expect(opened).toEqual([]);

    post({ type: "openAdjacentFile", direction: "next" });
    await settle();
    expect(shownPage()).not.toBe(firstPage);
    expect(opened).toEqual(["after second"]);
  });

  it("keeps the page number when new colours redraw the same diff", async () => {
    let colors = BLUE;
    await panels(highlighter(() => Promise.resolve(colors))).open(request());
    const page = shownPage();
    expect(page).toBeGreaterThan(0);

    colors = RED;
    changeColorThemeKind(ColorThemeKind.Light);
    await vi.waitFor(() => expect(onlyPanel().webview.html).toContain("#ff0000"));

    expect(shownPage()).toBe(page);
  });

  it("ignores a file step the shown diff cannot take", async () => {
    await panels(highlighter(() => Promise.resolve(BLUE))).open(request());

    post({ type: "openAdjacentFile", direction: "next" });
    await settle();

    expect(vscodeMock.messages).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("reports a file that cannot be opened instead of rejecting", async () => {
    const failing = () => Promise.reject(new Error("This comparison is no longer available."));
    await panels(highlighter(() => Promise.resolve(BLUE))).open(request(inList({ next: failing })));
    await settle();

    post({ type: "openAdjacentFile", direction: "next" });
    await settle();

    expect(vscodeMock.messages).toEqual([
      { level: "error", text: "jw-differ could not open the next file. This comparison is no longer available." },
    ]);
    expect(logged[0]).toContain("This comparison is no longer available.");
  });

  it("releases its documents once when the panel closes", async () => {
    const opened = request();
    await panels(highlighter(() => Promise.resolve(BLUE))).open(opened);

    onlyPanel().dispose();
    post({ type: "openNative" });

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

  it("tells each request when the tab shows it, before releasing the file it replaced", async () => {
    const events: string[] = [];
    const tracked = (name: string): TwoWayDiffRequest => request({
      shown: () => void events.push(`${name} shown`),
      release: () => void events.push(`${name} released`),
    });
    const diffPanels = panels(highlighter(() => Promise.resolve(BLUE)));
    await diffPanels.open(tracked("first"));
    await diffPanels.open(tracked("second"));

    onlyPanel().dispose();

    expect(events).toEqual(["first shown", "second shown", "first released", "second released"]);
  });

  it("never reports a file shown when rendering it fails", async () => {
    const events: string[] = [];
    const diffPanels = panels(highlighter(() => Promise.resolve(BLUE)));
    await diffPanels.open(request());
    const failing = request({ shown: () => void events.push("shown"), release: () => void events.push("released") });

    await expect(diffPanels.open({ ...failing, base: unrenderable(failing.base) })).rejects.toThrow("render broke");

    expect(events).toEqual(["released"]);
  });

  it("sends the native-diff request for the file the reused tab currently shows", async () => {
    const first = request();
    const second = request();
    const diffPanels = panels(highlighter(() => Promise.resolve(BLUE)));
    await diffPanels.open(first);
    await diffPanels.open(second);

    post({ type: "openNative" });
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

    changeConfiguration("jwDiffer.wordLevelHighlighting", false);
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

  describe("working copy", () => {
    let directory: string;

    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "jw-differ-working-copy-"));
      vscodeMock.openFileDocument = (uri) => ({ uri, getText: () => fs.readFileSync(uri.fsPath, "utf8") }) as unknown as vscode.TextDocument;
    });

    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    /** The working file of `src/app.ts`, holding `text`. */
    function workingCopy(text: string): vscode.Uri {
      const filePath = path.join(directory, "app.ts");
      fs.writeFileSync(filePath, text);
      return vscode.Uri.file(filePath);
    }

    /** Opens a diff with `changes` and sends the message F4 posts for `line`. */
    async function pressF4(changes: Partial<TwoWayDiffRequest>, line: unknown): Promise<void> {
      await panels(highlighter(() => Promise.resolve(BLUE))).open(request(changes));
      post({ type: "openWorkingCopy", line });
    }

    function rightSide(text: string): TwoWayDiffRequest["result"] {
      return { ...request().result, text };
    }

    /** The line each shown document's cursor was put on. */
    function shownLines(): number[] {
      return vscodeMock.shownDocuments.map(({ options }) => (options?.selection as vscode.Range).start.line);
    }

    it("opens the working file at the same line when the right side matches it, editable in a tab of its own", async () => {
      const uri = workingCopy("a\nb\nc\n");

      await pressF4({ result: rightSide("a\nb\nc\n"), workingCopy: uri }, 2);

      await vi.waitFor(() => expect(vscodeMock.shownDocuments).toHaveLength(1));
      const [{ document, options }] = vscodeMock.shownDocuments;
      expect(document.uri.fsPath).toBe(uri.fsPath);
      expect(options).toEqual({ preview: false, selection: new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, 0)) });
    });

    it("follows the line to where later commits and edits moved it", async () => {
      const uri = workingCopy("added 1\nadded 2\na\nb\nc\nd\n");

      await pressF4({ result: rightSide("a\nremoved\nb\nc\nd\n"), workingCopy: uri }, 3);

      await vi.waitFor(() => expect(shownLines()).toEqual([4]));
    });

    it("maps onto the editor's unsaved text, not the file on disk", async () => {
      const uri = workingCopy("a\nb\n");
      vscodeMock.openFileDocument = (opened) => ({ uri: opened, getText: () => "typed\na\nb\n" }) as unknown as vscode.TextDocument;

      await pressF4({ result: rightSide("a\nb\n"), workingCopy: uri }, 1);

      await vi.waitFor(() => expect(shownLines()).toEqual([2]));
    });

    it("goes to the nearest line when the line is gone from the working file", async () => {
      const uri = workingCopy("a");

      await pressF4({ result: rightSide("a\nb\nc"), workingCopy: uri }, 2);

      await vi.waitFor(() => expect(shownLines()).toEqual([0]));
    });

    it("says so when the working file was deleted or renamed", async () => {
      const uri = vscode.Uri.file(path.join(directory, "gone.ts"));

      await pressF4({ workingCopy: uri }, 0);

      await vi.waitFor(() => expect(vscodeMock.messages).toHaveLength(1));
      expect(vscodeMock.messages).toEqual([
        { level: "information", text: "src/app.ts is not in the working copy; it may have been deleted or renamed." },
      ]);
      expect(vscodeMock.shownDocuments).toEqual([]);
    });

    it("says so when the right side deletes the file", async () => {
      await pressF4({}, 0);
      await settle();

      expect(vscodeMock.messages).toEqual([{ level: "information", text: "The right side deletes this file, so it has no working copy." }]);
      expect(vscodeMock.shownDocuments).toEqual([]);
    });

    it("reports a working file that cannot be opened instead of rejecting", async () => {
      const uri = workingCopy("a\n");
      vscodeMock.openFileDocument = () => {
        throw new Error("file is binary");
      };

      await pressF4({ workingCopy: uri }, 0);

      await vi.waitFor(() => expect(vscodeMock.messages).toHaveLength(1));
      expect(vscodeMock.messages).toEqual([{ level: "error", text: "jw-differ could not open the working copy. file is binary" }]);
      expect(logged[0]).toContain("file is binary");
    });

    it("ignores a request without a valid line", async () => {
      const uri = workingCopy("a\n");
      await pressF4({ workingCopy: uri }, -1);
      for (const line of [1.5, "2", undefined]) {
        post({ type: "openWorkingCopy", line });
      }
      await settle();

      expect(vscodeMock.shownDocuments).toEqual([]);
      expect(vscodeMock.messages).toEqual([]);
    });
  });
});
