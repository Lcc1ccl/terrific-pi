import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

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

test("editor embeds a width-safe status source in the bottom-right border", () => {
  const status = "gpt-5 high · EDIT · fast";
  const budgets: number[] = [];
  const editor = new AppearanceEditor(tui, editorTheme, keys, (width) => {
    budgets.push(width);
    return truncateToWidth(status, width, "");
  });

  const lines = editor.render(40).map(stripAnsi);
  assert.match(lines.at(-1) ?? "", / gpt-5 high · EDIT · fast ╯$/);
  assert.ok((budgets.at(-1) ?? 40) < 40);

  editor.setText(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
  for (const width of [1, 2, 3, 4, 12, 24, 40]) {
    const rendered = editor.render(width).map(stripAnsi);
    if (width >= 24) assert.ok(rendered.some((line) => /^╭.*↑ \d+ more.*╮$/.test(line)));
    for (const line of rendered) assert.ok(visibleWidth(line) <= width);
  }
  assert.match(editor.render(40).map(stripAnsi).at(-1) ?? "", / gpt-5 high · EDIT · fast ╯$/);
});

test("editor restores the border tone after colored status metadata", () => {
  const coloredTheme = {
    ...editorTheme,
    borderColor: (text: string) => `\x1b[34m${text}\x1b[39m`,
  } as EditorTheme;
  const editor = new AppearanceEditor(
    tui,
    coloredTheme,
    keys,
    () => "\x1b[31mstatus\x1b[39m",
  );
  const bottom = editor.render(24).at(-1) ?? "";
  assert.match(bottom, /\x1b\[31mstatus\x1b\[39m\x1b\[34m ╯\x1b\[39m$/);
});
