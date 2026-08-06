import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { widgetEditorAction } from "../lib/configure.ts";
import { formatWidgetsPreview, formatWidgetsPreviewLines } from "../lib/widgets.ts";
import type { WidgetLines } from "../lib/types.ts";

function lines(partial: Partial<WidgetLines>): WidgetLines {
	return { line0: [], line1: [], line2: [], line3: [], line4: [], ...partial };
}

describe("formatWidgetsPreview", () => {
	it("renders sample segments in explicit line order", () => {
		const preview = formatWidgetsPreview(lines({ line0: ["model"], line2: ["path", "cache"], line4: ["state"] }));
		assert.match(preview, /model high/);
		assert.match(preview, /proj|~/);
		assert.match(preview, /🎯 \d+\.\d+%/);
		assert.match(preview, /Ready/);
	});

	it("uses active display settings", () => {
		const value = lines({ line1: ["tokens", "cache"] });
		const preview = formatWidgetsPreview(value, {
			...DEFAULT_CONFIG,
			lines: value,
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

	it("returns none when all lines are empty", () => {
		assert.equal(formatWidgetsPreview(lines({})), "(none)");
	});

	it("shows optional widgets with sample data", () => {
		const value = lines({
			line0: ["mode"],
			line2: ["quota", "cost"],
			line3: ["environment"],
			line4: ["toolActivity", "runTtft", "runStalls"],
		});
		const rendered = formatWidgetsPreviewLines(value, {
			...DEFAULT_CONFIG,
			lines: value,
			iconMode: "plain",
			toolActivityMode: "detailed",
		}).join(" ");
		assert.match(rendered, /usage|5h/);
		assert.match(rendered, /context files|skills/);
		assert.match(rendered, /Read|ok/);
		assert.match(rendered, /EDIT/);
		assert.match(rendered, /\$0\.42/);
		assert.match(rendered, /TTFT 1\.2s/);
		assert.match(rendered, /stall 1\/4\.3s/);
	});

	it("returns one preview row per nonempty configured line", () => {
		const value = lines({ line0: ["model"], line1: ["path"], line3: ["tokens"], line4: ["state"] });
		const rendered = formatWidgetsPreviewLines(value, { ...DEFAULT_CONFIG, lines: value, iconMode: "plain" });
		assert.equal(rendered.length, 4);
		assert.match(rendered[0]!, /model high/);
		assert.match(rendered[1]!, /proj|~/);
		assert.match(rendered[2]!, /in /);
		assert.match(rendered[3]!, /Ready/);
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
