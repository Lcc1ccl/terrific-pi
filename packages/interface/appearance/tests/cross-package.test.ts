import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import appearance from "../extensions/appearance.ts";
import presentation from "../../presentation/extensions/presentation.ts";
import statusline from "../../statusline/extensions/statusline.ts";
import taskboard from "../../taskboard/extensions/taskboard.ts";

type Owner = "appearance" | "presentation" | "statusline" | "taskboard";
type Handler = (event: any, ctx: any) => unknown;

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousStatuslineConfig = process.env.PI_STATUSLINE_CONFIG;
const cleanup: string[] = [];

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousStatuslineConfig === undefined) delete process.env.PI_STATUSLINE_CONFIG;
  else process.env.PI_STATUSLINE_CONFIG = previousStatuslineConfig;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createHarness(enabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "phase6-cross-package-"));
  cleanup.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_STATUSLINE_CONFIG = join(dir, "statusline.json");
  writeFileSync(process.env.PI_STATUSLINE_CONFIG, JSON.stringify({ widgets: ["path"], telemetry: { display: "off" } }));
  writeFileSync(join(dir, "terrific.json"), JSON.stringify({
    appearance: { enabled, settingsLanguage: "en", header: true, editor: true },
    presentation: { enabled: true },
  }));

  const handlers = new Map<string, Array<{ owner: Owner; handler: Handler }>>();
  const commands = new Map<string, Owner>();
  const tools = new Map<string, Owner>();
  const renderers = new Map<string, Owner>();
  const calls = {
    footer: [] as Owner[],
    header: [] as Owner[],
    editor: [] as Owner[],
    status: [] as Owner[],
    widget: [] as Owner[],
    notify: [] as Owner[],
  };
  let activeOwner: Owner | undefined;
  let editorFactory: unknown;

  const events = {
    on() { return () => {}; },
    emit() {},
  };
  const api = (owner: Owner) => ({
    events,
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), { owner, handler }]);
    },
    registerCommand(name: string) { commands.set(name, owner); },
    registerShortcut() {},
    registerTool(value: { name: string }) { tools.set(value.name, owner); },
    registerEntryRenderer(name: string) { renderers.set(name, owner); },
    appendEntry() {},
    getCommands() { return [...commands.keys()].map((name) => ({ name, source: "test" })); },
    getThinkingLevel() { return "high"; },
    async exec() { return { code: 1, stdout: "", stderr: "", killed: false }; },
  });

  statusline(api("statusline") as never);
  taskboard(api("taskboard") as never);
  presentation(api("presentation") as never);
  appearance(api("appearance") as never);

  const ctx = {
    cwd: dir,
    mode: "tui",
    hasUI: true,
    model: { provider: "openai", id: "gpt-test", reasoning: false },
    signal: undefined,
    getContextUsage: () => undefined,
    sessionManager: {
      getBranch: () => [],
      getLeafId: () => "leaf-1",
      getSessionName: () => undefined,
    },
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ ok: false, error: "disabled" }),
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setFooter() { calls.footer.push(activeOwner!); },
      setHeader() { calls.header.push(activeOwner!); },
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory: unknown) { calls.editor.push(activeOwner!); editorFactory = factory; },
      setStatus() { calls.status.push(activeOwner!); },
      setWidget() { calls.widget.push(activeOwner!); },
      getToolsExpanded: () => false,
      notify() { calls.notify.push(activeOwner!); },
    },
  };

  return {
    calls,
    commands,
    tools,
    renderers,
    async emit(name: string) {
      for (const item of handlers.get(name) ?? []) {
        activeOwner = item.owner;
        await item.handler({ type: name, reason: "startup" }, ctx);
      }
      activeOwner = undefined;
    },
  };
}

test("statusline, taskboard, presentation, and appearance preserve UI ownership disabled and enabled", async () => {
  for (const enabled of [false, true]) {
    const harness = createHarness(enabled);
    await harness.emit("session_start");

    assert.deepEqual(harness.calls.footer, ["statusline"]);
    assert.equal(harness.tools.get("process_update"), "taskboard");
    assert.equal([...harness.renderers.values()].every((owner) => owner === "presentation"), true);
    assert.equal(harness.renderers.size, 3);
    assert.equal(harness.commands.get("taskboard"), "taskboard");
    assert.equal(harness.commands.get("presentation"), "presentation");

    if (enabled) {
      assert.deepEqual(harness.calls.header, ["appearance"]);
      assert.deepEqual(harness.calls.editor, ["appearance"]);
    } else {
      assert.deepEqual(harness.calls.header, []);
      assert.deepEqual(harness.calls.editor, []);
    }
    assert.equal(harness.calls.status.every((owner) => owner === "taskboard"), true);
    assert.equal(harness.calls.widget.every((owner) => owner === "taskboard"), true);
    assert.equal(harness.calls.notify.includes("appearance"), false);

    await harness.emit("session_shutdown");
  }
});
