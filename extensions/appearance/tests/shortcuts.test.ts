import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { SHORTCUT_WIDGET_KEY, createShortcutsWidget } from "../lib/shortcuts.ts";

function harness(rows: number, bindings: Record<string, string[]>) {
  const requested: string[] = [];
  const manager = {
    getKeys(action: string) { requested.push(action); return bindings[action] ?? []; },
  };
  const tui = { terminal: { rows } };
  const theme = { fg: (_token: string, text: string) => text };
  return { widget: createShortcutsWidget(tui as never, theme as never, manager as never), requested };
}

describe("appearance shortcuts", () => {
  it("uses the exact widget key", () => assert.equal(SHORTCUT_WIDGET_KEY, "terrific-pi:appearance-shortcuts"));
  it("builds only from injected manager bindings and omits missing actions", () => {
    const { widget, requested } = harness(24, {
      "tui.input.submit": ["f13"],
      "tui.input.newLine": ["shift+f13"],
      "app.tools.expand": [],
      "app.thinking.toggle": ["ctrl+t"],
      "app.model.select": ["ctrl+l"],
    });
    const text = widget.render(120).join("\n");
    assert.match(text, /f13/);
    assert.doesNotMatch(text, /tools/i);
    assert.ok(requested.includes("tui.input.submit"));
    assert.ok(requested.includes("app.model.select"));
  });
  it("hides and clears visible content at the exact thresholds", () => {
    const state = harness(24, { "tui.input.submit": ["enter"] });
    assert.notDeepEqual(state.widget.render(72), []);
    assert.deepEqual(state.widget.render(71), []);
    (state.widget as any).tui.terminal.rows = 16;
    assert.deepEqual(state.widget.render(120), []);
    (state.widget as any).tui.terminal.rows = 20;
    assert.notDeepEqual(state.widget.render(120), []);
  });
  for (const rows of [16, 20, 24]) {
    for (const width of [40, 80, 120, 160]) {
      it(`is responsive at ${width} columns and ${rows} rows`, () => {
        const { widget } = harness(rows, { "tui.input.submit": ["enter"], "tui.input.newLine": ["shift+enter"], "app.tools.expand": ["ctrl+o"], "app.thinking.toggle": ["ctrl+t"], "app.model.select": ["ctrl+l"] });
        const lines = widget.render(width);
        assert.equal(lines.length > 0, width >= 72 && rows >= 20);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
      });
    }
  }
});
