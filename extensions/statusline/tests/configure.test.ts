import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildWidgetEditorItems,
	enabledFromEditorItems,
	formatConfigSummary,
	formatSettingChoices,
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
	it("accepts integers from 4 to 40", () => {
		assert.deepEqual(parseContextBarWidth("10"), { ok: true, value: 10 });
		assert.deepEqual(parseContextBarWidth(" 4 "), { ok: true, value: 4 });
		assert.deepEqual(parseContextBarWidth("40"), { ok: true, value: 40 });
	});

	it("rejects invalid widths", () => {
		assert.equal(parseContextBarWidth("3").ok, false);
		assert.equal(parseContextBarWidth("41").ok, false);
		assert.equal(parseContextBarWidth("8.5").ok, false);
		assert.equal(parseContextBarWidth("abc").ok, false);
		assert.equal(parseContextBarWidth("").ok, false);
	});
});

describe("formatSettingChoices", () => {
	it("puts the current value first and marks current and default values", () => {
		assert.deepEqual(
			formatSettingChoices(["single", "stacked"], "stacked", "single"),
			["stacked [current]", "single [default]"],
		);
		assert.deepEqual(
			formatSettingChoices(["on", "off"], "off", "off"),
			["off [current] [default]", "on"],
		);
	});
});

describe("parseWidgetSpacing", () => {
	it("accepts integers from 0 to 4", () => {
		assert.deepEqual(parseWidgetSpacing("0"), { ok: true, value: 0 });
		assert.deepEqual(parseWidgetSpacing(" 1 "), { ok: true, value: 1 });
		assert.deepEqual(parseWidgetSpacing("4"), { ok: true, value: 4 });
	});

	it("rejects values outside 0 to 4 and reports the default", () => {
		for (const raw of ["-1", "5", "1.5", "abc", ""]) {
			const result = parseWidgetSpacing(raw);
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.error, /default 1/);
		}
	});
});

describe("formatConfigSummary", () => {
	it("renders a compact multi-line summary", () => {
		const config: StatuslineConfig = {
			widgets: ["path", "cost"],
			layout: "single",
			iconMode: "emoji",
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			spacing: 1,
		};
		const summary = formatConfigSummary(config, "/tmp/statusline.json");
		assert.match(summary, /widgets: path, cost/);
		assert.match(summary, /layout: single/);
		assert.match(summary, /iconMode: emoji/);
		assert.match(summary, /contextMode: remaining/);
		assert.match(summary, /contextBarWidth: 10 \(default 10, min 4, max 40\)/);
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
			layout: "single",
			iconMode: "emoji",
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
				confirm: async () => true,
				notify: () => {},
			},
		}, ["path"]);

		assert.equal(mainCalls, 1);
		assert.equal(nestedCalls, 0);
	});
});

describe("widget editor apply", () => {
	it("reports a rejected config mutation back to the editor", async () => {
		const config: StatuslineConfig = {
			widgets: ["path"],
			layout: "single",
			iconMode: "emoji",
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			spacing: 1,
		};
		const choices = ["Widgets", "Done"];
		let accepted: boolean | undefined;

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: () => ({ ok: false, error: "save failed" }),
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => ({ ok: true, value: undefined }),
			ui: {
				selectMain: async () => choices.shift(),
				select: async () => undefined,
				input: async () => undefined,
				editWidgets: async (_title, _all, _enabled, onChange) => {
					accepted = onChange(["state"]);
					return undefined;
				},
				confirm: async () => true,
				notify: () => {},
			},
		}, ["path", "state"]);

		assert.equal(accepted, false);
	});
});

describe("setting menus", () => {
	it("shows current/default markers and preselects the current value", async () => {
		const config: StatuslineConfig = {
			widgets: ["path"],
			layout: "stacked",
			iconMode: "emoji",
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			spacing: 1,
		};
		const choices = ["Layout", "Done"];
		let nestedItems: string[] | undefined;

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: () => ({ ok: true, value: undefined }),
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => ({ ok: true, value: undefined }),
			ui: {
				selectMain: async () => choices.shift(),
				select: async (_title, items) => {
					nestedItems = items;
					return undefined;
				},
				input: async () => undefined,
				editWidgets: async () => undefined,
				confirm: async () => true,
				notify: () => {},
			},
		}, ["path"]);

		assert.deepEqual(nestedItems, ["stacked [current]", "single [default]", "Back"]);
	});
});

describe("reset confirmation", () => {
	it("does not reset when confirmation is declined", async () => {
		const config: StatuslineConfig = {
			widgets: ["path"],
			layout: "single",
			iconMode: "emoji",
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			spacing: 1,
		};
		const choices = ["Reset to defaults", "Done"];
		let resets = 0;
		let confirmations = 0;

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: () => ({ ok: true, value: undefined }),
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => {
				resets += 1;
				return { ok: true, value: undefined };
			},
			ui: {
				selectMain: async () => choices.shift(),
				select: async () => undefined,
				input: async () => undefined,
				editWidgets: async () => undefined,
				confirm: async () => {
					confirmations += 1;
					return false;
				},
				notify: () => {},
			},
		}, ["path"]);

		assert.equal(confirmations, 1);
		assert.equal(resets, 0);
	});
});

describe("widget spacing prompt", () => {
	it("shows the default, minimum, and maximum values", async () => {
		const config: StatuslineConfig = {
			widgets: ["path"],
			layout: "single",
			iconMode: "emoji",
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
				confirm: async () => true,
				notify: () => {},
			},
		}, ["path"]);

		assert.equal(inputTitle, "Widget spacing per side (default 1, min 0, max 4)");
		assert.equal(inputValue, "1");
	});
});

describe("context bar width prompt", () => {
	it("shows the default, minimum, and maximum values", async () => {
		const config: StatuslineConfig = {
			widgets: ["path"],
			layout: "single",
			iconMode: "emoji",
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			spacing: 1,
		};
		const choices = ["Context bar width", "Done"];
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
				confirm: async () => true,
				notify: () => {},
			},
		}, ["path"]);

		assert.equal(inputTitle, "Context bar width (default 10, min 4, max 40)");
		assert.equal(inputValue, "10");
	});
});
