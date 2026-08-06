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

function harness(configText?: string, options: { mode?: string; hasUI?: boolean; foreign?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "appearance-extension-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  if (configText !== undefined) writeFileSync(join(dir, "terrific.json"), configText, "utf8");
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let editorFactory = options.foreign;
  const calls = { header: 0, editor: 0, notify: [] as string[] };
  let command: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
  const pi = {
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
  return { handlers, ctx, calls, getEditorFactory: () => editorFactory, command };
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
