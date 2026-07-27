import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import appearance from "../extensions/appearance.ts";

const dirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function setConfig(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "appearance-ext-")); dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "terrific.json"), content);
  return dir;
}

interface UiCall {
  method: "setHeader" | "setEditorComponent" | "setWidget" | "notify";
  args: any[];
}

function createFakeUi(initialEditor?: any) {
  const calls: UiCall[] = [];
  let editorFactory = initialEditor;
  let headerFactory: any;
  let widgetContent: any;
  const ui = {
    setHeader(...args: any[]) { calls.push({ method: "setHeader", args }); headerFactory = args[0]; },
    setEditorComponent(factory: any) { calls.push({ method: "setEditorComponent", args: [factory] }); editorFactory = factory; },
    getEditorComponent() { return editorFactory; },
    setWidget(...args: any[]) { calls.push({ method: "setWidget", args }); widgetContent = args[1]; },
    notify(...args: any[]) { calls.push({ method: "notify", args }); },
  };
  return {
    calls,
    ui,
    get editorFactory() { return editorFactory; },
    get headerFactory() { return headerFactory; },
    get widgetContent() { return widgetContent; },
  };
}

type FakeUi = ReturnType<typeof createFakeUi>;

function createHarness(mode: "tui" | "print" | "json" | "rpc" = "tui", fake: FakeUi = createFakeUi()) {
  const handlers = new Map<string, Function[]>();
  const api = { on(name: string, handler: Function) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); } };
  appearance(api as never);
  return {
    fake,
    ui: fake.ui,
    mark: () => fake.calls.length,
    callsSince: (index: number) => fake.calls.slice(index),
    allCalls: () => [...fake.calls],
    async emit(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}, { mode, ui: fake.ui }); },
    factory: () => fake.editorFactory,
  };
}

function active() { setConfig(JSON.stringify({ appearance: { profile: "terrific-native-v1" } })); }

function fakeEditorArgs() {
  return [
    { terminal: { rows: 24 }, requestRender() {} },
    { borderColor: (s: string) => s },
    { matches: () => false, getKeys: (action: string) => action === "tui.input.submit" ? ["enter"] : [] },
  ] as const;
}

describe("appearance extension lifecycle", () => {
  it("has zero UI side effects when inactive", async () => { setConfig("{}"); const h = createHarness(); await h.emit("session_start"); assert.deepEqual(h.allCalls(), []); });
  it("has zero UI side effects outside TUI even when active", async () => { active(); for (const mode of ["print", "json", "rpc"] as const) { const h = createHarness(mode); await h.emit("session_start"); assert.deepEqual(h.allCalls(), []); } });
  it("notifies once for malformed global config in TUI", async () => { setConfig("{"); const h = createHarness(); await h.emit("session_start"); await h.emit("session_start"); assert.equal(h.allCalls().filter((c) => c.method === "notify").length, 1); assert.equal(h.allCalls().filter((c) => c.method !== "notify").length, 0); });
  it("rereads profile activation within one extension generation", async () => {
    const dir = setConfig("{}");
    const current = createHarness();
    writeFileSync(join(dir, "terrific.json"), JSON.stringify({ appearance: { profile: "terrific-native-v1" } }));

    await current.emit("session_start");
    assert.equal(current.allCalls().filter((call) => call.method === "setHeader").length, 1);
    assert.equal(typeof current.factory(), "function");
  });
  it("sets header but refuses an existing non-appearance editor", async () => {
    active(); const prior = () => ({ render: () => [], invalidate() {} });
    const h = createHarness(); h.ui.setEditorComponent(prior); const mark = h.mark();
    await h.emit("session_start");
    const calls = h.callsSince(mark);
    assert.equal(calls.filter((c) => c.method === "setHeader").length, 1);
    assert.equal(calls.filter((c) => c.method === "notify").length, 1);
    assert.equal(h.factory(), prior);
    assert.equal(calls.filter((c) => c.method === "setWidget").length, 0);
  });
  it("clears the header on shutdown after a foreign editor conflict", async () => {
    active();
    const prior = () => ({ render: () => [], invalidate() {} });
    const h = createHarness();
    h.ui.setEditorComponent(prior);
    const startMark = h.mark();

    await h.emit("session_start");
    assert.ok(h.callsSince(startMark).some((call) => call.method === "setHeader" && typeof call.args[0] === "function"));
    assert.equal(h.factory(), prior);
    const shutdownMark = h.mark();

    await h.emit("session_shutdown");
    const shutdownCalls = h.callsSince(shutdownMark);
    assert.ok(shutdownCalls.some((call) => call.method === "setHeader" && call.args[0] === undefined));
    assert.equal(h.factory(), prior);
    assert.equal(shutdownCalls.filter((call) => call.method === "setWidget").length, 0);
  });
  it("installs shortcuts only after factory captures manager and prevents duplicates", async () => {
    active(); const h = createHarness(); await h.emit("session_start");
    assert.equal(h.allCalls().filter((c) => c.method === "setWidget").length, 0);
    h.factory()!(...fakeEditorArgs() as any); h.factory()!(...fakeEditorArgs() as any);
    const widgets = h.allCalls().filter((c) => c.method === "setWidget" && c.args[1] !== undefined);
    assert.equal(widgets.length, 1); assert.equal(widgets[0]?.args[0], "terrific-pi:appearance-shortcuts"); assert.deepEqual(widgets[0]?.args[2], { placement: "belowEditor" });
  });
  it("stale generation cleanup does not clear a newer generation", async () => {
    active();
    const fake = createFakeUi();
    const old = createHarness("tui", fake); await old.emit("session_start"); old.factory()!(...fakeEditorArgs() as any);
    const newer = createHarness("tui", fake); await newer.emit("session_start"); const newerFactory = newer.factory(); newerFactory!(...fakeEditorArgs() as any);
    const newerHeader = fake.headerFactory;
    const newerWidget = fake.widgetContent;
    const shutdownMark = old.mark();
    await old.emit("session_shutdown");
    assert.equal(fake.editorFactory, newerFactory);
    assert.equal(fake.headerFactory, newerHeader);
    assert.equal(fake.widgetContent, newerWidget);
    assert.deepEqual(old.callsSince(shutdownMark), []);
  });
  it("stale header-only conflict cleanup preserves a newer full generation", async () => {
    active();
    const foreign = () => ({ render: () => [], invalidate() {} });
    const fake = createFakeUi(foreign);
    const conflicted = createHarness("tui", fake);
    await conflicted.emit("session_start");
    assert.equal(fake.editorFactory, foreign);
    assert.equal(fake.widgetContent, undefined);

    fake.ui.setEditorComponent(undefined);
    const newer = createHarness("tui", fake);
    await newer.emit("session_start");
    const newerEditor = newer.factory();
    newerEditor!(...fakeEditorArgs() as any);
    const newerHeader = fake.headerFactory;
    const newerWidget = fake.widgetContent;

    const shutdownMark = conflicted.mark();
    await conflicted.emit("session_shutdown");
    assert.equal(fake.headerFactory, newerHeader);
    assert.equal(fake.editorFactory, newerEditor);
    assert.equal(fake.widgetContent, newerWidget);
    assert.deepEqual(conflicted.callsSince(shutdownMark), []);
  });
  it("current cleanup clears owned UI and restores the previous factory only while still current", async () => {
    active(); const h = createHarness(); await h.emit("session_start"); const owned = h.factory(); owned!(...fakeEditorArgs() as any);
    const shutdownMark = h.mark(); await h.emit("session_shutdown");
    const calls = h.callsSince(shutdownMark);
    assert.ok(calls.some((c) => c.method === "setWidget" && c.args[1] === undefined));
    assert.ok(calls.some((c) => c.method === "setHeader" && c.args[0] === undefined));
    assert.ok(calls.some((c) => c.method === "setEditorComponent" && c.args[0] === undefined));
  });
  it("survives ten start/shutdown/reload cycles without duplicate widgets", async () => {
    active();
    const h = createHarness();
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await h.emit("session_start");
      const factory = h.factory();
      assert.equal(typeof factory, "function");
      factory!(...fakeEditorArgs() as any);
      factory!(...fakeEditorArgs() as any);
      await h.emit("session_shutdown");
    }
    const calls = h.allCalls();
    assert.equal(calls.filter((call) => call.method === "setHeader" && typeof call.args[0] === "function").length, 10);
    assert.equal(calls.filter((call) => call.method === "setHeader" && call.args[0] === undefined).length, 10);
    assert.equal(calls.filter((call) => call.method === "setWidget" && call.args[1] !== undefined).length, 10);
    assert.equal(calls.filter((call) => call.method === "setWidget" && call.args[1] === undefined).length, 10);
    assert.equal(h.factory(), undefined);
  });
  it("does not overwrite an editor factory replaced after installation", async () => {
    active(); const h = createHarness(); await h.emit("session_start"); const replacement = () => ({ render: () => [], invalidate() {} }); h.ui.setEditorComponent(replacement); const shutdownMark = h.mark();
    await h.emit("session_shutdown"); assert.equal(h.factory(), replacement); assert.equal(h.callsSince(shutdownMark).filter((c) => c.method === "setEditorComponent").length, 0);
  });
});

describe("package and forbidden API surface", () => {
  it("declares a zero-runtime-dependency Pi package with real resources", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.type, "module"); assert.equal(pkg.dependencies, undefined);
    assert.deepEqual(pkg.pi.extensions, ["./extensions/appearance.ts"]); assert.deepEqual(pkg.pi.themes, ["./themes"]);
    for (const keyword of ["pi-package", "pi-extension", "pi-theme"]) assert.ok(pkg.keywords.includes(keyword));
    for (const version of Object.values(pkg.peerDependencies)) assert.equal(version, "*");
  });
  it("does not use forbidden host APIs", () => {
    const source = readFileSync(new URL("../extensions/appearance.ts", import.meta.url), "utf8") + readFileSync(new URL("../lib/editor.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /setFooter|setStatus|setWorkingVisible|registerMessageRenderer|prototype\s*\.|setInterval|setTimeout|setTheme|fetch\(|pi\.exec|settings\.json/);
  });
});
