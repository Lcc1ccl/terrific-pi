import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { widgetEditorAction } from "../lib/configure.ts";
import { formatWidgetsPreview, formatWidgetsPreviewLines } from "../lib/widgets.ts";

describe("formatWidgetsPreview", () => {
	it("renders sample segments for enabled widgets", () => {
		const preview = formatWidgetsPreview(["path", "cache", "state"]);
		assert.match(preview, /proj|~/);
		assert.match(preview, /🎯 \d+\.\d+%/);
		assert.match(preview, /Ready/);
	});

	it("uses the active display settings", () => {
		const preview = formatWidgetsPreview(["tokens", "cache"], {
			...DEFAULT_CONFIG,
			widgets: ["tokens", "cache"],
			iconMode: "plain",
			minimal: true,
			separator: "bar",
			spacing: 0,
		});
		assert.doesNotMatch(preview, /🔼|🔽|🎯/);
		assert.match(preview, /in 1\.5KⅠ 3\.7K · out 800Ⅰ 900/);
		assert.match(preview, /CH 66\.7%/);
		assert.match(preview, /│/);
	});

	it("returns none when empty", () => {
		assert.equal(formatWidgetsPreview([]), "(none)");
	});

	it("mock preview still shows optional widgets with sample data", () => {
		const lines = formatWidgetsPreviewLines(
			["quota", "environment", "toolActivity", "mode", "cost", "runTtft", "runStalls"],
			{ ...DEFAULT_CONFIG, iconMode: "plain", toolActivityMode: "detailed" },
		);
		const joined = lines.join(" ");
		assert.match(joined, /usage|5h/);
		assert.match(joined, /context files|skills/);
		assert.match(joined, /Read|ok/);
		assert.match(joined, /EDIT/);
		assert.match(joined, /\$0\.42/);
		assert.match(joined, /TTFT 1\.2s/);
		assert.match(joined, /stall 1\/4\.3s/);
	});

	it("stacked mock preview returns one line per partition with data", () => {
		const lines = formatWidgetsPreviewLines(
			["path", "tokens", "session", "state"],
			{ ...DEFAULT_CONFIG, layout: "stacked", iconMode: "plain" },
		);
		assert.ok(lines.length >= 2);
		assert.match(lines[0]!, /proj|~/);
		assert.match(lines.join(" "), /in |Ready|session/);
	});
});

describe("widgetEditorAction", () => {
	it("uses injected selection keybindings", () => {
		const keybindings = {
			matches: (data: string, binding: string) =>
				(data === "next" && binding === "tui.select.down")
				|| (data === "move" && binding === "tui.editor.cursorRight"),
		};
		assert.equal(widgetEditorAction("next", keybindings), "down");
		assert.equal(widgetEditorAction("move", keybindings), "right");
		assert.equal(widgetEditorAction(" ", keybindings), "toggle");
	});
});
