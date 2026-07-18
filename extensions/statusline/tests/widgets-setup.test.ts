import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { widgetEditorAction } from "../lib/configure.ts";
import { formatWidgetsPreview } from "../lib/widgets.ts";

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
		assert.match(preview, /1\.5K.*800/);
		assert.match(preview, /│/);
	});

	it("returns none when empty", () => {
		assert.equal(formatWidgetsPreview([]), "(none)");
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
