import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildWidgetEditorItems,
	enabledFromEditorItems,
	flattenEnabledByGroup,
	formatConfigSummary,
	formatSettingChoices,
	moveEditorItem,
	moveEnabledInGroups,
	moveInGroups,
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

	it("lists all widgets by partition (enabled flag independent of order)", () => {
		const items = buildWidgetEditorItems(["cost", "path"], catalog);
		// order: cost, path, model, state → project: path, model · usage: cost · activity: state
		assert.deepEqual(items, [
			{ id: "path", enabled: true },
			{ id: "model", enabled: false },
			{ id: "cost", enabled: true },
			{ id: "state", enabled: false },
		]);
		assert.deepEqual(enabledFromEditorItems(items), ["path", "cost"]);
	});

	it("moves disabled widgets across partitions too", () => {
		// Full order includes disabled model between path and tokens visually after group flatten.
		const order = ["path", "model", "tokens", "state"];
		const moved = moveInGroups(order, undefined, "model", 1);
		assert.ok(moved);
		assert.equal(moved!.widgetGroups?.model, "usage");
		assert.deepEqual(moved!.order, ["path", "model", "tokens", "state"]);
	});

	it("crosses partitions landing on the near edge of the destination section", () => {
		const movedRight = moveEnabledInGroups(["path", "model", "tokens", "state"], undefined, "model", 1);
		assert.ok(movedRight);
		// path, model | tokens | state → path | model, tokens | state (first of next section)
		assert.deepEqual(movedRight!.enabled, ["path", "model", "tokens", "state"]);
		assert.equal(movedRight!.widgetGroups?.model, "usage");
		assert.deepEqual(
			flattenEnabledByGroup(movedRight!.enabled, movedRight!.widgetGroups),
			["path", "model", "tokens", "state"],
		);

		const movedLeft = moveEnabledInGroups(["path", "model", "tokens", "state"], undefined, "tokens", -1);
		assert.ok(movedLeft);
		// tokens enters project as last: path, model, tokens | state
		assert.deepEqual(movedLeft!.enabled, ["path", "model", "tokens", "state"]);
		assert.equal(movedLeft!.widgetGroups?.tokens, "project");
		assert.deepEqual(
			flattenEnabledByGroup(movedLeft!.enabled, movedLeft!.widgetGroups),
			["path", "model", "tokens", "state"],
		);
	});

	it("swaps with the neighbor inside the same partition", () => {
		const moved = moveEnabledInGroups(["path", "model", "tokens"], undefined, "path", 1);
		assert.ok(moved);
		assert.deepEqual(moved!.enabled, ["model", "path", "tokens"]);
		assert.equal(moved!.widgetGroups, undefined);
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
			separator: "dot",
			spacing: 1,
			toolActivityMode: "detailed",
		};
		const summary = formatConfigSummary(config, "/tmp/statusline.json");
		assert.match(summary, /widgets: path, cost/);
		assert.match(summary, /layout: single/);
		assert.match(summary, /iconMode: emoji/);
		assert.match(summary, /contextMode: remaining/);
		assert.match(summary, /contextBarWidth: 10 \(default 10, min 4, max 40\)/);
		assert.match(summary, /minimal: false/);
		assert.match(summary, /toolActivityMode: detailed/);
		assert.match(summary, /separator: dot \(·\)/);
		assert.match(summary, /spacing: 1 \(default 1, min 0, max 4\)/);
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
			separator: "dot",
			spacing: 1,
			toolActivityMode: "detailed",
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
			separator: "dot",
			spacing: 1,
			toolActivityMode: "detailed",
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
				editWidgets: async (_title, _all, _enabled, _groups, onChange) => {
					accepted = onChange(["state"], undefined);
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
			separator: "dot",
			spacing: 1,
			toolActivityMode: "compact",
		};
		const mainChoices = ["Appearance", "Done"];
		const appearanceChoices = ["Layout", "Back"];
		let nestedItems: string[] | undefined;

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: () => ({ ok: true, value: undefined }),
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => ({ ok: true, value: undefined }),
			ui: {
				selectMain: async () => mainChoices.shift(),
				select: async (title, items) => {
					if (title.startsWith("Appearance")) return appearanceChoices.shift();
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

describe("appearance submenu", () => {
	it("groups appearance settings and applies separator from the submenu", async () => {
		let config: StatuslineConfig = {
			widgets: ["path"],
			layout: "single",
			iconMode: "emoji",
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			separator: "dot",
			spacing: 1,
			toolActivityMode: "compact",
		};
		const mainChoices = ["Appearance", "Done"];
		const appearanceChoices = ["Widget separator", "Back"];
		let mainItems: string[] = [];
		let appearanceItems: string[] = [];

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: (next) => {
				config = next;
				return { ok: true, value: undefined };
			},
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => ({ ok: true, value: undefined }),
			ui: {
				selectMain: async (_title, items) => {
					mainItems = items;
					return mainChoices.shift();
				},
				select: async (title, items) => {
					if (title.startsWith("Appearance")) {
						appearanceItems = items;
						return appearanceChoices.shift();
					}
					if (title.includes("Widget separator")) return "bar";
					return undefined;
				},
				input: async () => undefined,
				editWidgets: async () => undefined,
				confirm: async () => true,
				notify: () => {},
			},
		}, ["path"]);

		assert.deepEqual(mainItems, [
			"Widgets",
			"Appearance",
			"Context & usage",
			"Show config",
			"Reload from file",
			"Reset to defaults",
			"Done",
		]);
		assert.ok(appearanceItems.includes("Widget separator"));
		assert.ok(appearanceItems.includes("Minimal profile"));
		assert.equal(
			appearanceItems.indexOf("Widget separator") + 1,
			appearanceItems.indexOf("Widget spacing"),
		);
		assert.equal(config.separator, "bar");
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
			separator: "dot",
			spacing: 1,
			toolActivityMode: "detailed",
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
			separator: "dot",
			spacing: 1,
			toolActivityMode: "compact",
		};
		const mainChoices = ["Appearance", "Done"];
		const appearanceChoices = ["Widget spacing", "Back"];
		let inputTitle: string | undefined;
		let inputValue: string | undefined;

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: () => ({ ok: true, value: undefined }),
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => ({ ok: true, value: undefined }),
			ui: {
				selectMain: async () => mainChoices.shift(),
				select: async (title) => {
					if (title.startsWith("Appearance")) return appearanceChoices.shift();
					return undefined;
				},
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

		assert.equal(
			inputTitle,
			"Widget spacing — spaces on each side of separator (default 1, min 0, max 4)",
		);
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
			separator: "dot",
			spacing: 1,
			toolActivityMode: "compact",
		};
		const mainChoices = ["Context & usage", "Done"];
		const usageChoices = ["Context bar width", "Back"];
		let inputTitle: string | undefined;
		let inputValue: string | undefined;

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: () => ({ ok: true, value: undefined }),
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => ({ ok: true, value: undefined }),
			ui: {
				selectMain: async () => mainChoices.shift(),
				select: async (title) => {
					if (title.startsWith("Context & usage")) return usageChoices.shift();
					return undefined;
				},
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

		assert.equal(
			inputTitle,
			"Context bar width — only when contextBar enabled (default 10, min 4, max 40)",
		);
		assert.equal(inputValue, "10");
	});
});

describe("minimal profile menu", () => {
	it("writes the package minimal profile on on", async () => {
		let config: StatuslineConfig = {
			widgets: ["path", "session", "model", "state"],
			layout: "stacked",
			iconMode: "emoji",
			contextMode: "remaining",
			contextBarWidth: 10,
			minimal: false,
			separator: "bar",
			spacing: 2,
			toolActivityMode: "detailed",
		};
		const mainChoices = ["Appearance", "Done"];
		const appearanceChoices = ["Minimal profile", "Back"];
		let mainItems: string[] = [];

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: (next) => {
				config = next;
				return { ok: true, value: undefined };
			},
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => ({ ok: true, value: undefined }),
			ui: {
				selectMain: async (_title, items) => {
					mainItems = items;
					return mainChoices.shift();
				},
				select: async (title) => {
					if (title.startsWith("Appearance")) return appearanceChoices.shift();
					if (title.includes("Minimal profile")) return "on";
					return undefined;
				},
				input: async () => undefined,
				editWidgets: async () => undefined,
				confirm: async () => true,
				notify: () => {},
			},
		}, ["path"]);

		assert.ok(mainItems.includes("Appearance"));
		assert.equal(mainItems.includes("Minimal profile"), false);
		assert.equal(mainItems.includes("Minimal mode"), false);
		assert.deepEqual(config.widgets, [
			"path",
			"session",
			"model",
			"branch",
			"tokens",
			"cache",
			"cost",
			"context",
			"mode",
			"fast",
			"progress",
			"state",
		]);
		assert.equal(config.layout, "single");
		assert.equal(config.iconMode, "plain");
		assert.equal(config.minimal, true);
		assert.equal(config.contextMode, "used");
		assert.equal(config.separator, "dot");
		assert.equal(config.toolActivityMode, "compact");
	});

	it("clears abbr labels only when turning off", async () => {
		let config: StatuslineConfig = {
			widgets: [
				"path",
				"session",
				"model",
				"branch",
				"tokens",
				"cache",
				"cost",
				"context",
				"mode",
				"fast",
				"progress",
				"state",
			],
			layout: "single",
			iconMode: "plain",
			contextMode: "used",
			contextBarWidth: 10,
			minimal: true,
			separator: "dot",
			spacing: 1,
			toolActivityMode: "compact",
		};
		const mainChoices = ["Appearance", "Done"];
		const appearanceChoices = ["Minimal profile", "Back"];

		await runStatuslineConfigurator({
			getConfig: () => config,
			getConfigPath: () => "/tmp/statusline.json",
			applyConfig: (next) => {
				config = next;
				return { ok: true, value: undefined };
			},
			reloadConfig: () => ({ ok: true, value: config }),
			resetConfig: () => ({ ok: true, value: undefined }),
			ui: {
				selectMain: async () => mainChoices.shift(),
				select: async (title) => {
					if (title.startsWith("Appearance")) return appearanceChoices.shift();
					if (title.includes("Minimal profile")) return "off";
					return undefined;
				},
				input: async () => undefined,
				editWidgets: async () => undefined,
				confirm: async () => true,
				notify: () => {},
			},
		}, ["path"]);

		assert.equal(config.minimal, false);
		assert.deepEqual(config.widgets, [
			"path",
			"session",
			"model",
			"branch",
			"tokens",
			"cache",
			"cost",
			"context",
			"mode",
			"fast",
			"progress",
			"state",
		]);
		assert.equal(config.layout, "single");
	});
});
