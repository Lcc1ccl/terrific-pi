import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";

import { TerrificEditor, fitBorderLabel } from "../lib/editor.ts";

const originalKeybindings = getKeybindings();
afterEach(() => setKeybindings(originalKeybindings));
after(() => assert.equal(getKeybindings(), originalKeybindings));

const editorTheme = {
  borderColor: (text: string) => `\u001b[34m${text}\u001b[39m`,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
} as never;

function createEditor(rows = 24, userBindings: Record<string, string | string[]> = {}) {
  const tui = { terminal: { rows }, requestRender() {} } as never;
  const definitions = {
    ...TUI_KEYBINDINGS,
    "app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
  } as never;
  const keybindings = new KeybindingsManager(definitions, userBindings as never);
  setKeybindings(keybindings);
  return { editor: new TerrificEditor(tui, editorTheme, keybindings as never), keybindings };
}

describe("TerrificEditor", () => {
  it("inherits CustomEditor behavior without overriding input or padding", () => {
    assert.ok(new TerrificEditor({ terminal: { rows: 24 }, requestRender() {} } as never, editorTheme, { matches: () => false, getKeys: () => [] } as never) instanceof CustomEditor);
    assert.equal(TerrificEditor.prototype.handleInput, CustomEditor.prototype.handleInput);
    assert.equal(TerrificEditor.prototype.setPaddingX, CustomEditor.prototype.setPaddingX);
  });

  for (const [rowIndex, rows] of [16, 20, 24].entries()) {
    for (const [widthIndex, width] of [40, 80, 120, 160].entries()) {
      const padding = [0, 1, 2][(rowIndex + widthIndex) % 3] ?? 0;
      it(`renders empty and hostile input at ${width}x${rows}, padding ${padding}`, () => {
        const { editor } = createEditor(rows);
        editor.setPaddingX(padding);
        assert.equal(editor.getPaddingX(), padding);

        const emptyLines = editor.render(width);
        assert.match(emptyLines[0] ?? "", /❯|>/);
        assert.ok(emptyLines.every((line) => visibleWidth(line) <= width));
        assert.equal(visibleWidth(emptyLines[0] ?? ""), width);
        assert.equal(visibleWidth(emptyLines.at(-1) ?? ""), width);

        editor.handleInput("typed");
        editor.handleInput("\n");
        editor.insertTextAtCursor("界面🙂 e\u0301 \u001b[31mANSI\u001b[39m");
        const paste = Array.from({ length: 11 }, (_, index) => `粘贴${index}🙂`).join("\n");
        editor.handleInput(`\u001b[200~${paste}\u001b[201~`);
        assert.equal(editor.getExpandedText(), `typed\n界面🙂 e\u0301 \u001b[31mANSI\u001b[39m${paste}`);
        assert.match(editor.getText(), /\[paste #1 \+11 lines\]/);

        const lines = editor.render(width);
        assert.match(lines[0] ?? "", /❯|>/);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.equal(visibleWidth(lines[0] ?? ""), width);
        assert.equal(visibleWidth(lines.at(-1) ?? ""), width);
        assert.doesNotMatch(lines.at(-1) ?? "", /cwd|model|token|context|mode/i);
      });
    }
  }

  it("inherits cancel and history draft restore at 40x16", () => {
    const { editor } = createEditor(16);
    let interrupted = 0;
    editor.onEscape = () => { interrupted += 1; };
    editor.addToHistory("historic command");
    editor.setText("draft");
    editor.handleInput("\u0001");
    editor.handleInput("\u001b[A");
    assert.equal(editor.getText(), "historic command");
    editor.handleInput("\u001b[B");
    assert.equal(editor.getText(), "draft");
    editor.handleInput("\u001b");
    assert.equal(interrupted, 1);

    const lines = editor.render(40);
    assert.match(lines[0] ?? "", /❯|>/);
    assert.ok(lines.every((line) => visibleWidth(line) <= 40));
    assert.equal(visibleWidth(lines[0] ?? ""), 40);
    assert.equal(visibleWidth(lines.at(-1) ?? ""), 40);
  });

  it("preserves native submit, newline, interrupt, history, and paste paths", () => {
    const { editor } = createEditor(24, { "app.interrupt": "ctrl+x" });
    let submitted = "";
    let interrupted = 0;
    editor.onSubmit = (text) => { submitted = text; };
    editor.onEscape = () => { interrupted += 1; };

    editor.setText("line one");
    editor.handleInput("\n");
    editor.handleInput("line two");
    assert.equal(editor.getText(), "line one\nline two");
    editor.handleInput("\r");
    assert.equal(submitted, "line one\nline two");

    editor.handleInput("\u001b");
    assert.equal(interrupted, 0);
    editor.handleInput("\u0018");
    assert.equal(interrupted, 1);

    editor.addToHistory("historic command");
    editor.handleInput("\u001b[A");
    assert.equal(editor.getText(), "historic command");

    editor.setText("");
    editor.handleInput("\u001b[200~first\n第二🙂e\u0301\u001b[201~");
    assert.equal(editor.getText(), "first\n第二🙂e\u0301");
    const largePaste = Array.from({ length: 11 }, (_, index) => `row-${index}`).join("\n");
    editor.setText("");
    editor.handleInput(`\u001b[200~${largePaste}\u001b[201~`);
    assert.match(editor.getText(), /^\[paste #1 \+11 lines\]$/);
    assert.equal(editor.getExpandedText(), largePaste);
  });

  it("preserves native autocomplete request and completion", async () => {
    const { editor } = createEditor();
    editor.setAutocompleteProvider({
      async getSuggestions() {
        return { prefix: "fi", items: [{ value: "final", label: "final" }] };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const line = lines[cursorLine] ?? "";
        return {
          lines: [...lines.slice(0, cursorLine), `${line.slice(0, cursorCol - prefix.length)}${item.value}${line.slice(cursorCol)}`, ...lines.slice(cursorLine + 1)],
          cursorLine,
          cursorCol: cursorCol - prefix.length + item.value.length,
        };
      },
      shouldTriggerFileCompletion() { return true; },
    });
    editor.setText("fi");
    editor.handleInput("\t");
    await new Promise<void>((resolve) => setImmediate(resolve));
    editor.handleInput("\t");
    assert.equal(editor.getText(), "final");
  });

  it("budgets ANSI, CJK, emoji, and combining labels safely", () => {
    for (const label of ["\u001b[36mANSI\u001b[39m", "界面", "🙂", "e\u0301"]) {
      for (const width of [40, 80, 120, 160]) {
        const line = fitBorderLabel(label, width, 2, (text) => `\u001b[34m${text}\u001b[39m`);
        assert.equal(visibleWidth(line), width);
      }
    }
  });
});
