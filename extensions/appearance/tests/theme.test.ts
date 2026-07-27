import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { loadThemeFromPath } = await import(join(packageRoot, "dist/modes/interactive/theme/theme.js"));
const themePath = new URL("../themes/terrific-night.json", import.meta.url);
const frozen = ["#0a0a0a", "#141414", "#1c1c1c", "#242424", "#e1e1e1", "#c8c8c8", "#6c6c6c", "#585858", "#7aa2f7", "#7dcfff", "#9ece6a", "#bb9af7", "#ff9e64", "#e0af68", "#f7768e"];

describe("terrific-night theme", () => {
  it("has the frozen palette, required tokens, and explicit export colors", () => {
    const json = JSON.parse(readFileSync(themePath, "utf8"));
    assert.equal(json.name, "terrific-night");
    assert.deepEqual(Object.values(json.vars), frozen);
    for (const token of ["accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText", "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode"]) assert.ok(token in json.colors, token);
    assert.deepEqual(Object.keys(json.export).sort(), ["cardBg", "infoBg", "pageBg"]);
  });
  for (const mode of ["truecolor", "256color"] as const) {
    it(`loads through the Pi 0.81.1 loader in ${mode}`, () => {
      const theme = loadThemeFromPath(themePath.pathname, mode);
      assert.equal(theme.name, "terrific-night"); assert.equal(theme.getColorMode(), mode);
      assert.match(theme.fg("accent", "x"), mode === "truecolor" ? /38;2;/ : /38;5;/);
    });
  }
});
