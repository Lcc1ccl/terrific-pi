import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildWidgetEditorItems,
	enabledFromEditorItems,
	formatConfigSummary,
	moveEditorItem,
	moveWidget,
	parseContextBarWidth,
	parseSeparator,
	swapAdjacent,
	toggleEditorItem,
	toggleWidget,
} from "../lib/configure.ts";
import type { StatuslineConfig } from "../lib/types.ts";

describe("toggleWidget", () => {
	it("disables an enabled widget", () => {
		const result = toggleWidget(["path", "cost", "state"], "cost");
		assert.deepEqual(result, { ok: true, value: ["path", "state"] });
	});

	it("enables a disabled widget by appending", () => {
		const result = toggleWidget(["path", "state"], "cost");
		assert.deepEqual(result, { ok: true, value: ["path", "state", "cost"] });
	});

	it("refuses to disable the last widget", () => {
		const result = toggleWidget(["path"], "path");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /at least one/i);
		}
	});
});

describe("moveWidget", () => {
	it("moves a widget up and down", () => {
		assert.deepEqual(moveWidget(["path", "model", "cost"], "model", "up"), {
			ok: true,
			value: ["model", "path", "cost"],
		});
		assert.deepEqual(moveWidget(["path", "model", "cost"], "model", "down"), {
			ok: true,
			value: ["path", "cost", "model"],
		});
	});

	it("rejects moves past the ends or unknown widgets", () => {
		assert.equal(moveWidget(["path", "model"], "path", "up").ok, false);
		assert.equal(moveWidget(["path", "model"], "model", "down").ok, false);
		assert.equal(moveWidget(["path", "model"], "cost", "up").ok, false);
	});
});

describe("swapAdjacent", () => {
	it("swaps with left/right neighbor and tracks selection", () => {
		assert.deepEqual(swapAdjacent(["a", "b", "c"], 1, -1), {
			items: ["b", "a", "c"],
			index: 0,
		});
		assert.deepEqual(swapAdjacent(["a", "b", "c"], 1, 1), {
			items: ["a", "c", "b"],
			index: 2,
		});
	});

	it("no-ops at list ends", () => {
		assert.equal(swapAdjacent(["a", "b"], 0, -1), undefined);
		assert.equal(swapAdjacent(["a", "b"], 1, 1), undefined);
	});
});

describe("widget editor items", () => {
	const catalog = ["path", "model", "cost", "state"] as const;

	it("puts enabled widgets first in config order", () => {
		const items = buildWidgetEditorItems(["cost", "path"], catalog);
		assert.deepEqual(items, [
			{ id: "cost", enabled: true },
			{ id: "path", enabled: true },
			{ id: "model", enabled: false },
			{ id: "state", enabled: false },
		]);
		assert.deepEqual(enabledFromEditorItems(items), ["cost", "path"]);
	});

	it("toggles and refuses disabling the last enabled widget", () => {
		const items = buildWidgetEditorItems(["path"], catalog);
		// order: path(on), model(off), cost(off), state(off)
		const enabled = toggleEditorItem(items, 1); // model
		assert.equal(enabled.ok, true);
		if (enabled.ok) {
			assert.deepEqual(enabledFromEditorItems(enabled.value), ["path", "model"]);
		}

		const blocked = toggleEditorItem(items, 0); // only path enabled
		assert.equal(blocked.ok, false);
	});

	it("moves items and preserves enabled order after swap", () => {
		const items = buildWidgetEditorItems(["path", "model"], catalog);
		const moved = moveEditorItem(items, 0, 1);
		assert.equal(moved.ok, true);
		if (moved.ok) {
			assert.equal(moved.value.index, 1);
			assert.deepEqual(enabledFromEditorItems(moved.value.items), ["model", "path"]);
		}
	});
});

describe("parseContextBarWidth", () => {
	it("accepts integers from 1 to 40", () => {
		assert.deepEqual(parseContextBarWidth("10"), { ok: true, value: 10 });
		assert.deepEqual(parseContextBarWidth(" 1 "), { ok: true, value: 1 });
		assert.deepEqual(parseContextBarWidth("40"), { ok: true, value: 40 });
	});

	it("rejects invalid widths", () => {
		assert.equal(parseContextBarWidth("0").ok, false);
		assert.equal(parseContextBarWidth("41").ok, false);
		assert.equal(parseContextBarWidth("8.5").ok, false);
		assert.equal(parseContextBarWidth("abc").ok, false);
		assert.equal(parseContextBarWidth("").ok, false);
	});
});

describe("parseSeparator", () => {
	it("accepts non-empty separators including spaces", () => {
		assert.deepEqual(parseSeparator(" · "), { ok: true, value: " · " });
		assert.deepEqual(parseSeparator(" | "), { ok: true, value: " | " });
		assert.deepEqual(parseSeparator("  "), { ok: true, value: "  " });
	});

	it("rejects empty separators", () => {
		assert.equal(parseSeparator("").ok, false);
	});
});

describe("formatConfigSummary", () => {
	it("renders a compact multi-line summary", () => {
		const config: StatuslineConfig = {
			widgets: ["path", "cost"],
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			separator: " · ",
		};
		const summary = formatConfigSummary(config, "/tmp/statusline.json");
		assert.match(summary, /widgets: path, cost/);
		assert.match(summary, /contextMode: remaining/);
		assert.match(summary, /contextBarWidth: 10/);
		assert.match(summary, /minimal: false/);
		assert.match(summary, /separator: " · "/);
		assert.match(summary, /config: \/tmp\/statusline\.json/);
	});
});
