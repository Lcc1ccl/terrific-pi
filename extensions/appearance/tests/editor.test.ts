import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import { AppearanceEditor } from "../lib/editor.ts";
import { stripAnsi } from "../lib/utils.ts";

const tui = { terminal: { rows: 24 }, requestRender() {} } as TUI;
const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
} as EditorTheme;
const keys = { matches: () => false } as unknown as KeybindingsManager;

test("editor inherits native behavior and overrides only render and padding", () => {
  assert.equal(Object.getPrototypeOf(AppearanceEditor.prototype), CustomEditor.prototype);
  assert.deepEqual(Object.getOwnPropertyNames(AppearanceEditor.prototype).sort(), ["constructor", "render", "setPaddingX"].sort());
  for (const method of ["handleInput", "setText", "getText", "getExpandedText", "addToHistory", "insertTextAtCursor", "setAutocompleteProvider"]) {
    assert.equal(method in AppearanceEditor.prototype, true, method);
    assert.equal(Object.hasOwn(AppearanceEditor.prototype, method), false, method);
  }
  const editor = new AppearanceEditor(tui, editorTheme, keys);
  assert.equal(editor.handleInput, CustomEditor.prototype.handleInput);
  assert.ok(editor.actionHandlers instanceof Map);
  assert.equal("onPasteImage" in editor, true);
});

test("editor keeps rounded rails, native content, padding compensation, and safe widths", () => {
  const editor = new AppearanceEditor(tui, editorTheme, keys);
  editor.setText("native input");
  editor.setPaddingX(2);
  for (const width of [1, 2, 3, 4, 10, 24, 80]) {
    const lines = editor.render(width);
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  }
  const lines = editor.render(40).map(stripAnsi);
  assert.match(lines[0] ?? "", /^╭.*╮$/);
  assert.ok(lines.some((line) => line.startsWith("│ ") && line.endsWith(" │") && line.includes("native input")));
  assert.ok(lines.some((line) => /^╰.*╯$/.test(line)));

  editor.setText(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
  const scrolled = editor.render(24).map(stripAnsi);
  assert.ok(scrolled.some((line) => /^╭.*↑ \d+ more.*╮$/.test(line)));
  for (const line of scrolled) assert.ok(visibleWidth(line) <= 24);
});
