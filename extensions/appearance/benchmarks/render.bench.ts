import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  getKeybindings,
  setKeybindings,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { p95 } from "./p95.ts";
import { TerrificEditor } from "../lib/editor.ts";
import { createTerrificHeader } from "../lib/header.ts";
import { createShortcutsWidget } from "../lib/shortcuts.ts";

const WIDTH = 160;
const SAMPLE_COUNT = 30;
const WARMUP_COUNT = 8;

function measureRender(render: () => string[]): { samples: number[]; p95Ms: number; last: string[] } {
  for (let index = 0; index < WARMUP_COUNT; index += 1) render();

  const samples: number[] = [];
  let last: string[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now();
    const lines = render();
    const duration = performance.now() - startedAt;
    samples.push(duration);
    last = lines;
  }
  return { samples, p95Ms: p95(samples), last };
}

function createKeybindings(): KeybindingsManager {
  const definitions = {
    ...TUI_KEYBINDINGS,
    "app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
    "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    "app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking" },
    "app.model.select": { defaultKeys: "ctrl+l", description: "Select model" },
  } as never;
  return new KeybindingsManager(definitions);
}

const theme = {
  fg: (_token: string, text: string) => `\u001b[36m${text}\u001b[39m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
};

const editorTheme = {
  borderColor: (text: string) => `\u001b[34m${text}\u001b[39m`,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};

function report(name: string, result: ReturnType<typeof measureRender>): void {
  assert.equal(result.samples.length, SAMPLE_COUNT);
  assert.ok(result.last.length > 0);
  assert.ok(result.last.every((line) => visibleWidth(line) <= WIDTH));
  console.log(`appearance ${name} width=${WIDTH} samples=${SAMPLE_COUNT} p95=${result.p95Ms.toFixed(3)}ms`);
  assert.ok(result.p95Ms < 16, `${name} render p95 ${result.p95Ms.toFixed(3)}ms`);
}

const originalKeybindings = getKeybindings();
try {
  const tui = { terminal: { rows: 24 }, requestRender() {} };

  const header = createTerrificHeader(tui as never, theme as never);
  report("header", measureRender(() => header.render(WIDTH)));

  const keybindings = createKeybindings();
  setKeybindings(keybindings);
  const editor = new TerrificEditor(tui as never, editorTheme as never, keybindings as never);
  editor.setPaddingX(2);
  editor.setText(Array.from({ length: 8 }, (_, index) => `第${index}行 🙂 e\u0301 \u001b[3${index % 7 + 1}mANSI\u001b[39m`).join("\n"));
  const paste = Array.from({ length: 11 }, (_, index) => `粘贴-${index}-界面🙂`).join("\n");
  editor.handleInput(`\u001b[200~${paste}\u001b[201~`);
  const editorResult = measureRender(() => editor.render(WIDTH));
  assert.match(editor.getText(), /\[paste #1 \+11 lines\]/);
  assert.equal(visibleWidth(editorResult.last[0] ?? ""), WIDTH);
  assert.equal(visibleWidth(editorResult.last.at(-1) ?? ""), WIDTH);
  report("editor", editorResult);

  const shortcuts = createShortcutsWidget(tui as never, theme as never, keybindings as never);
  report("shortcuts", measureRender(() => shortcuts.render(WIDTH)));
} finally {
  setKeybindings(originalKeybindings);
}
assert.equal(getKeybindings(), originalKeybindings);
