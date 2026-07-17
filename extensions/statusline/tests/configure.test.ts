import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildWidgetEditorItems,
	enabledFromEditorItems,
	formatConfigSummary,
	moveEditorItem,
	moveWidget,
	parseContextBarWidth,
	parseWidgetSpacing,
	runStatuslineConfigurator,
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

describe("parseWidgetSpacing", () => {
	it("accepts integers from 0 to 4", () => {
		assert.deepEqual(parseWidgetSpacing("0"), { ok: true, value: 0 });
		assert.deepEqual(parseWidgetSpacing(" 1 "), { ok: true, value: 1 });
		assert.deepEqual(parseWidgetSpacing("4"), { ok: true, value: 4 });
	});

	it("rejects values outside 0 to 4", () => {
		for (const raw of ["-1", "5", "1.5", "abc", ""]) {
			assert.equal(parseWidgetSpacing(raw).ok, false);
		}
	});
});

describe("formatConfigSummary", () => {
	it("renders a compact multi-line summary", () => {
		const config: StatuslineConfig = {
			widgets: ["path", "cost"],
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			spacing: 1,
		};
		const summary = formatConfigSummary(config, "/tmp/statusline.json");
		assert.match(summary, /widgets: path, cost/);
		assert.match(summary, /contextMode: remaining/);
		assert.match(summary, /contextBarWidth: 10/);
		assert.match(summary, /minimal: false/);
		assert.match(summary, /spacing: 1 \(default 1, min 0, max 4\)/);
		assert.doesNotMatch(summary, /separator:/);
		assert.match(summary, /config: \/tmp\/statusline\.json/);
	});
});

describe("main menu selector", () => {
	it("routes the top-level menu through the cyclic selector", async () => {
		const config: StatuslineConfig = {
			widgets: ["path"],
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			spacing: 1,
		};
		let mainCalls = 0;
		let nestedCalls = 0;

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: () => ({ ok: true, value: undefined }),
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => ({ ok: true, value: undefined }),
			ui: {
				selectMain: async () => {
					mainCalls += 1;
					return undefined;
				},
				select: async () => {
					nestedCalls += 1;
					return undefined;
				},
				input: async () => undefined,
				editWidgets: async () => undefined,
				notify: () => {},
			},
		}, ["path"]);

		assert.equal(mainCalls, 1);
		assert.equal(nestedCalls, 0);
	});
});

describe("widget spacing prompt", () => {
	it("shows the default, minimum, and maximum values", async () => {
		const config: StatuslineConfig = {
			widgets: ["path"],
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			spacing: 1,
		};
		const choices = ["Widget spacing", "Done"];
		let inputTitle: string | undefined;
		let inputValue: string | undefined;

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: () => ({ ok: true, value: undefined }),
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => ({ ok: true, value: undefined }),
			ui: {
				selectMain: async () => choices.shift(),
				select: async () => undefined,
				input: async (title, value) => {
					inputTitle = title;
					inputValue = value;
					return undefined;
				},
				editWidgets: async () => undefined,
				notify: () => {},
			},
		}, ["path"]);

		assert.equal(inputTitle, "Widget spacing per side (default 1, min 0, max 4)");
		assert.equal(inputValue, "1");
	});
});
