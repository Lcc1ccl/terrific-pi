import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createAppearanceSettings } from "../lib/settings.ts";
import type { AppearanceConfig } from "../lib/config.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

for (const language of ["en", "zh"] as const) {
  test(`settings ${language} stays within 24/36/48/80 columns`, () => {
    const config: AppearanceConfig = { enabled: true, settingsLanguage: language, header: true, editor: true };
    const settings = createAppearanceSettings(theme, config, () => {}, () => {});
    for (const width of [24, 36, 48, 80]) {
      const lines = settings.render(width);
      assert.ok(lines.length > 0);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${language}: ${visibleWidth(line)} > ${width}: ${line}`);
      const output = lines.join("\n");
      assert.match(output, language === "en" ? /General|Header|Editor|Language/ : /常规|页眉|编辑器|语言/);
    }
  });
}

test("settings changes only the four appearance fields", () => {
  const changes: AppearanceConfig[] = [];
  const config: AppearanceConfig = { enabled: false, settingsLanguage: "en", header: true, editor: true };
  const settings = createAppearanceSettings(theme, config, (next) => changes.push(next), () => {});
  settings.handleInput("\r");
  assert.deepEqual(changes.at(-1), { ...config, enabled: true });
});
