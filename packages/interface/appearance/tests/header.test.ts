import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

import { AppearanceHeader } from "../lib/header.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const pi = { getThinkingLevel: () => "high", getCommands: () => [{ name: "model" }, { name: "reload" }, { name: "appearance" }] } as unknown as ExtensionAPI;
const ctx = { cwd: "/work/project", model: { provider: "openai", id: "gpt-test" }, ui: { theme } } as unknown as ExtensionContext;

test("header is static, includes runtime facts and command tips, and never overflows", () => {
  const header = new AppearanceHeader(pi, ctx, {} as TUI);
  for (const width of [10, 23, 24, 36, 48, 80]) {
    const lines = header.render(width);
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
    if (width < 24) assert.equal(lines.length, 1);
  }
  const wide = header.render(80).join("\n");
  assert.match(wide, /Pi v\d/);
  assert.match(wide, /openai\/gpt-test/);
  assert.match(wide, /high/);
  assert.match(wide, /\/work\/project/);
  assert.match(wide, /\/appearance|\/model|\/reload/);
  assert.deepEqual(header.render(80), header.render(80));
});
