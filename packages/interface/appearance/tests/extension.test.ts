import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import appearance from "../extensions/appearance.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

function harness(configText?: string, options: { mode?: string; hasUI?: boolean; foreign?: unknown; statusText?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "appearance-extension-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  if (configText !== undefined) writeFileSync(join(dir, "terrific.json"), configText, "utf8");
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let editorFactory = options.foreign;
  const calls = { header: 0, editor: 0, notify: [] as string[] };
  const bridgeEvents: Array<{ name: string; active?: boolean }> = [];
  const bridgeRequests: Array<{ active?: boolean; attach?: (source: { render(line: "line0" | "line1", width: number): string }) => void; ownsEditor?: () => boolean }> = [];
  let command: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
  const pi = {
    events: {
      emit(name: string, value: unknown) {
        const request = value as { active?: boolean; attach?: (source: { render(line: "line0" | "line1", width: number): string }) => void };
        bridgeEvents.push({ name, active: request.active });
        bridgeRequests.push(request);
        if (request.active && options.statusText) {
          request.attach?.({ render: (line) => `${line}:${options.statusText!}` });
        }
      },
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
    registerCommand(_name: string, definition: { handler: typeof command }) { command = definition.handler; },
    getThinkingLevel: () => "high",
    getCommands: () => [{ name: "appearance" }, { name: "model" }, { name: "reload" }],
  } as unknown as ExtensionAPI;
  appearance(pi);
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    cwd: "/work/project",
    model: { provider: "openai", id: "gpt-test" },
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      getEditorComponent: () => editorFactory,
      setEditorComponent: (factory: unknown) => { calls.editor++; editorFactory = factory; },
      setHeader: (_factory: unknown) => { calls.header++; },
      notify: (message: string) => { calls.notify.push(message); },
    },
  } as unknown as ExtensionContext;
  return {
    handlers,
    ctx,
    calls,
    bridgeEvents,
    bridgeRequests,
    getEditorFactory: () => editorFactory,
    setEditorFactory: (value: unknown) => { editorFactory = value; },
    command,
  };
}

const enabled = JSON.stringify({ appearance: { enabled: true, settingsLanguage: "en", header: true, editor: true } });

describe("appearance extension ownership", () => {
  it("has zero UI side effects for absent, malformed, disabled, and headless config", async () => {
    const cases: Array<[string | undefined, { mode?: string; hasUI?: boolean } | undefined]> = [
      [undefined, undefined],
      ["{ bad", undefined],
      [JSON.stringify({ appearance: { enabled: false, settingsLanguage: "en", header: true, editor: true } }), undefined],
      [enabled, { mode: "rpc", hasUI: false }],
    ];
    for (const [config, options] of cases) {
      const scenario = harness(config, options);
      await scenario.handlers.get("session_start")?.({}, scenario.ctx);
      assert.deepEqual(scenario.calls, { header: 0, editor: 0, notify: [] });
    }
  });

  it("fails completely closed and notifies when a foreign editor owns the requested editor slot", async () => {
    const foreign = () => ({ render: () => [] });
    const h = harness(enabled, { foreign });
    await h.handlers.get("session_start")?.({}, h.ctx);
    assert.equal(h.getEditorFactory(), foreign);
    assert.equal(h.calls.editor, 0);
    assert.equal(h.calls.header, 0);
    assert.equal(h.calls.notify.length, 1);
    assert.match(h.calls.notify[0] ?? "", /editor.*owner|conflict/i);
  });

  it("allows a header-only configuration beside a foreign editor", async () => {
    const foreign = () => ({ render: () => [] });
    const config = JSON.stringify({ appearance: { enabled: true, settingsLanguage: "en", header: true, editor: false } });
    const h = harness(config, { foreign });
    await h.handlers.get("session_start")?.({}, h.ctx);
    assert.equal(h.getEditorFactory(), foreign);
    assert.equal(h.calls.editor, 0);
    assert.equal(h.calls.header, 1);
    assert.deepEqual(h.calls.notify, []);
  });

  it("attaches statusline metadata only while the appearance editor owns the surface", async () => {
    const h = harness(enabled, { statusText: "gpt-test high · EDIT · fast" });
    await h.handlers.get("session_start")?.({}, h.ctx);
    assert.deepEqual(h.bridgeEvents, []);

    const factory = h.getEditorFactory() as (tui: unknown, theme: unknown, keys: unknown) => { render(width: number): string[] };
    const editor = factory(
      { terminal: { rows: 24 }, requestRender() {} },
      {
        borderColor: (text: string) => text,
        selectList: {
          selectedPrefix: (text: string) => text,
          selectedText: (text: string) => text,
          description: (text: string) => text,
          scrollInfo: (text: string) => text,
          noMatch: (text: string) => text,
        },
      },
      { matches: () => false },
    );
    assert.deepEqual(h.bridgeEvents, [{ name: "terrific-pi:statusline:editor-v2", active: true }]);
    assert.equal(h.bridgeRequests[0]?.ownsEditor?.(), true);
    h.setEditorFactory(() => ({ render: () => [] }));
    assert.equal(h.bridgeRequests[0]?.ownsEditor?.(), false);
    const rendered = editor.render(60);
    assert.match(rendered[0] ?? "", /^╭ line0:gpt-test high · EDIT · fast /);
    assert.match(rendered.at(-1) ?? "", / line1:gpt-test high · EDIT · fast ╯$/);

    await h.handlers.get("session_shutdown")?.({}, h.ctx);
    assert.deepEqual(h.bridgeEvents.at(-1), { name: "terrific-pi:statusline:editor-v2", active: false });
  });

  it("cancels a mounted bridge request even when statusline has not attached a source", async () => {
    const h = harness(enabled);
    await h.handlers.get("session_start")?.({}, h.ctx);
    const factory = h.getEditorFactory() as (tui: unknown, theme: unknown, keys: unknown) => unknown;
    factory(
      { terminal: { rows: 24 }, requestRender() {} },
      {
        borderColor: (text: string) => text,
        selectList: {
          selectedPrefix: (text: string) => text,
          selectedText: (text: string) => text,
          description: (text: string) => text,
          scrollInfo: (text: string) => text,
          noMatch: (text: string) => text,
        },
      },
      { matches: () => false },
    );
    assert.deepEqual(h.bridgeEvents, [{ name: "terrific-pi:statusline:editor-v2", active: true }]);

    await h.handlers.get("session_shutdown")?.({}, h.ctx);
    assert.deepEqual(h.bridgeEvents.at(-1), { name: "terrific-pi:statusline:editor-v2", active: false });
  });

  it("does not attach statusline metadata when the editor is disabled or conflicted", async () => {
    const headerOnly = harness(JSON.stringify({ appearance: { enabled: true, settingsLanguage: "en", header: true, editor: false } }), { statusText: "hidden" });
    await headerOnly.handlers.get("session_start")?.({}, headerOnly.ctx);
    assert.deepEqual(headerOnly.bridgeEvents, []);

    const conflicted = harness(enabled, { foreign: () => ({ render: () => [] }), statusText: "hidden" });
    await conflicted.handlers.get("session_start")?.({}, conflicted.ctx);
    assert.deepEqual(conflicted.bridgeEvents, []);
  });

  it("installs one header and editor owner in each of 10 extension generations", async () => {
    for (let generation = 0; generation < 10; generation++) {
      const h = harness(enabled);
      assert.equal(h.handlers.size, 2);
      await h.handlers.get("session_start")?.({}, h.ctx);
      assert.equal(typeof h.getEditorFactory(), "function");
      await h.handlers.get("session_shutdown")?.({}, h.ctx);
      assert.equal(h.calls.header, 1);
      assert.equal(h.calls.editor, 1);
      assert.deepEqual(h.calls.notify, []);
    }
  });
});
