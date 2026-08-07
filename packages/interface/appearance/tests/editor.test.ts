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

test("editor embeds LINE0 at top-left and LINE1 at bottom-right", () => {
  const budgets: Array<{ line: "line0" | "line1"; width: number }> = [];
  const Editor = AppearanceEditor as unknown as new (
    tui: TUI,
    theme: EditorTheme,
    keys: KeybindingsManager,
    top: (width: number) => string,
    bottom: (width: number) => string,
  ) => AppearanceEditor;
  const editor = new Editor(
    tui,
    editorTheme,
    keys,
    (width) => {
      budgets.push({ line: "line0", width });
      return truncateToWidth("gpt-5 high · EDIT", width, "");
    },
    (width) => {
      budgets.push({ line: "line1", width });
      return truncateToWidth("📁 ~/terrific-pi", width, "");
    },
  );

  const lines = editor.render(50).map(stripAnsi);
  assert.match(lines[0] ?? "", /^╭ gpt-5 high · EDIT /);
  assert.match(lines.at(-1) ?? "", / 📁 ~\/terrific-pi ╯$/);
  assert.ok(budgets.some(({ line, width }) => line === "line0" && width < 50));
  assert.ok(budgets.some(({ line, width }) => line === "line1" && width < 50));

  editor.setText(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
  for (const width of [1, 2, 3, 4, 12, 24, 50]) {
    const rendered = editor.render(width).map(stripAnsi);
    if (width >= 24) assert.ok(rendered.some((line) => /^╭ gpt-5.*↑ \d+ more.*╮$/.test(line)));
    for (const line of rendered) assert.ok(visibleWidth(line) <= width);
  }
});

test("editor restores the border tone after colored status metadata", () => {
  const coloredTheme = {
    ...editorTheme,
    borderColor: (text: string) => `\x1b[34m${text}\x1b[39m`,
  } as EditorTheme;
  const Editor = AppearanceEditor as unknown as new (
    tui: TUI,
    theme: EditorTheme,
    keys: KeybindingsManager,
    top: (width: number) => string,
    bottom: (width: number) => string,
  ) => AppearanceEditor;
  const editor = new Editor(
    tui,
    coloredTheme,
    keys,
    () => "\x1b[31mtop\x1b[39m",
    () => "\x1b[32mbottom\x1b[39m",
  );
  const [top, ...rest] = editor.render(24);
  const bottom = rest.at(-1) ?? "";
  assert.match(top ?? "", /^\x1b\[34m╭ \x1b\[39m\x1b\[31mtop\x1b\[39m\x1b\[34m /);
  assert.match(bottom, /\x1b\[32mbottom\x1b\[39m\x1b\[34m ╯\x1b\[39m$/);
});
