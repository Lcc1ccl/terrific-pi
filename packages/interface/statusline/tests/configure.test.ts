import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cloneStatuslineConfig, DEFAULT_CONFIG } from "../lib/config.ts";
import {
	buildWidgetEditorItems,
	contextUsageItems,
	cycleWidgetLine,
	enabledLines,
	flattenWidgetLines,
	formatConfigSummary,
	formatSettingChoices,
	initialEditorLines,
	moveWidgetInLines,
	parseContextBarWidth,
	parseWidgetSpacing,
	runStatuslineConfigurator,
	toggleEditorItem,
} from "../lib/configure.ts";
import type { ConfigureDeps } from "../lib/configure.ts";
import type { StatuslineConfig, WidgetId, WidgetLines } from "../lib/types.ts";

function lines(partial: Partial<WidgetLines>): WidgetLines {
	return { line0: [], line1: [], line2: [], line3: [], line4: [], ...partial };
}

function config(partial: Partial<StatuslineConfig> = {}): StatuslineConfig {
	return { ...cloneStatuslineConfig(DEFAULT_CONFIG), ...partial };
}

function depsFor(
	initial: StatuslineConfig,
	choices: string[],
	overrides: Partial<ConfigureDeps["ui"]> = {},
): { deps: ConfigureDeps; getConfig(): StatuslineConfig } {
	let current = initial;
	const deps: ConfigureDeps = {
		getConfig: () => current,
		getConfigPath: () => "/tmp/statusline.json",
		applyConfig: (next) => {
			current = next;
			return { ok: true, value: undefined };
		},
		reloadConfig: () => ({ ok: true, value: current }),
		resetConfig: () => ({ ok: true, value: undefined }),
		ui: {
			selectMain: async () => choices.shift(),
			select: async () => undefined,
			input: async () => undefined,
			editWidgets: async () => undefined,
			confirm: async () => true,
			notify: () => {},
			...overrides,
		},
	};
	return { deps, getConfig: () => current };
}

describe("widget line editor operations", () => {
	const catalog = ["path", "model", "tokens", "state"] as const;

	it("keeps configured lines and stages disabled widgets in transient LINE1", () => {
		const editor = initialEditorLines(lines({ line0: ["model"], line3: ["state"] }), catalog);
		assert.deepEqual(editor, {
			line0: ["model"],
			line1: ["path", "tokens"],
			line2: [],
			line3: ["state"],
			line4: [],
		});
		const enabled = new Set<WidgetId>(["model", "state"]);
		assert.deepEqual(buildWidgetEditorItems(editor, enabled), [
			{ id: "model", line: "line0", enabled: true },
			{ id: "path", line: "line1", enabled: false },
			{ id: "tokens", line: "line1", enabled: false },
			{ id: "state", line: "line3", enabled: true },
		]);
		assert.deepEqual(enabledLines(editor, enabled), lines({ line0: ["model"], line3: ["state"] }));
	});

	it("restores disabled widgets from persisted editor lines", () => {
		const configured = lines({ line1: ["path"] });
		const persisted = lines({ line0: ["model"], line1: ["path"] });
		assert.deepEqual(initialEditorLines(configured, ["path", "model"], persisted), persisted);
	});

	it("moves within a line, enters empty lines, and wraps across LINE0/LINE4", () => {
		const value = lines({ line0: ["tokens", "model"], line2: ["path", "state"] });
		assert.deepEqual(moveWidgetInLines(value, "tokens", 1), lines({
			line0: ["model", "tokens"],
			line2: ["path", "state"],
		}));
		assert.deepEqual(moveWidgetInLines(value, "model", 1), lines({
			line0: ["tokens"],
			line1: ["model"],
			line2: ["path", "state"],
		}));
		assert.deepEqual(moveWidgetInLines(value, "path", -1), lines({
			line0: ["tokens", "model"],
			line1: ["path"],
			line2: ["state"],
		}));
		assert.deepEqual(moveWidgetInLines(lines({ line4: ["state"] }), "state", 1), lines({ line0: ["state"] }));
		assert.deepEqual(moveWidgetInLines(lines({ line0: ["model"] }), "model", -1), lines({ line4: ["model"] }));
	});

	it("cycles any widget through LINE0-LINE4", () => {
		const value = lines({ line0: ["tokens"], line4: ["state"] });
		assert.deepEqual(cycleWidgetLine(value, "tokens"), lines({ line1: ["tokens"], line4: ["state"] }));
		assert.deepEqual(cycleWidgetLine(value, "state"), lines({ line0: ["tokens", "state"] }));
	});

	it("toggles widgets but refuses to disable the last enabled item", () => {
		const items = [
			{ id: "path" as const, line: "line1" as const, enabled: true },
			{ id: "model" as const, line: "line0" as const, enabled: false },
		];
		const enabled = toggleEditorItem(items, 1);
		assert.equal(enabled.ok, true);
		if (enabled.ok) assert.deepEqual(enabled.value.map((item) => item.enabled), [true, true]);
		const blocked = toggleEditorItem(items, 0);
		assert.equal(blocked.ok, false);
		if (!blocked.ok) assert.match(blocked.error, /at least one/i);
	});

	it("flattens LINE0-LINE4 in display order", () => {
		assert.deepEqual(flattenWidgetLines(lines({ line0: ["model"], line2: ["tokens"], line4: ["state"] })), [
			"model", "tokens", "state",
		]);
	});
});

describe("setting parsers", () => {
	it("parses context bar widths from 4 to 40", () => {
		assert.deepEqual(parseContextBarWidth(" 4 "), { ok: true, value: 4 });
		assert.deepEqual(parseContextBarWidth("40"), { ok: true, value: 40 });
		for (const raw of ["3", "41", "8.5", "abc", ""]) assert.equal(parseContextBarWidth(raw).ok, false);
	});

	it("parses widget spacing from 0 to 4", () => {
		assert.deepEqual(parseWidgetSpacing("0"), { ok: true, value: 0 });
		assert.deepEqual(parseWidgetSpacing(" 4 "), { ok: true, value: 4 });
		for (const raw of ["-1", "5", "1.5", "abc", ""]) assert.equal(parseWidgetSpacing(raw).ok, false);
	});

	it("puts the current setting first and marks defaults", () => {
		assert.deepEqual(
			formatSettingChoices(["emoji", "plain"], "plain", "emoji"),
			["plain [current]", "emoji [default]"],
		);
	});
});

describe("config summary and conditional settings", () => {
	it("reports all five lines and omits obsolete layout fields", () => {
		const summary = formatConfigSummary(config({
			lines: lines({ line0: ["model"], line2: ["path", "cost"] }),
		}), "/tmp/statusline.json");
		assert.match(summary, /LINE0: model/);
		assert.match(summary, /LINE1: \(empty\)/);
		assert.match(summary, /LINE2: path, cost/);
		assert.match(summary, /LINE4: \(empty\)/);
		assert.doesNotMatch(summary, /layout:|widgetGroups:/);
		assert.match(summary, /runNotification: off/);
		assert.match(summary, /config: \/tmp\/statusline\.json/);
	});

	it("shows only settings backed by widgets enabled on any line", () => {
		assert.deepEqual(contextUsageItems(config({ lines: lines({ line0: ["path"] }) })), []);
		assert.deepEqual(contextUsageItems(config({ lines: lines({ line3: ["context"] }) })), ["Context mode"]);
		assert.deepEqual(
			contextUsageItems(config({ lines: lines({ line0: ["toolActivity"], line4: ["contextBar"] }) })),
			["Context mode", "Context bar width", "Tool activity mode"],
		);
	});
});

describe("statusline configurator", () => {
	it("routes the top-level menu through the main selector", async () => {
		let mainCalls = 0;
		let nestedCalls = 0;
		const { deps } = depsFor(config(), [], {
			selectMain: async () => { mainCalls += 1; return undefined; },
			select: async () => { nestedCalls += 1; return undefined; },
		});
		await runStatuslineConfigurator(deps, ["path"]);
		assert.equal(mainCalls, 1);
		assert.equal(nestedCalls, 0);
	});

	it("applies line changes and persists disabled widget ownership", async () => {
		const start = config({ lines: lines({ line1: ["path"] }) });
		const order = lines({ line0: ["model"], line1: ["path"], line4: ["state"] });
		const { deps, getConfig } = depsFor(start, ["Widgets", "Done"], {
			editWidgets: async (_title, _all, _lines, _order, onChange) => {
				assert.equal(onChange(lines({ line1: ["path"], line4: ["state"] }), order), true);
				return undefined;
			},
		});
		await runStatuslineConfigurator(deps, ["path", "model", "state"]);
		assert.deepEqual(getConfig().lines, lines({ line1: ["path"], line4: ["state"] }));
		assert.deepEqual(getConfig().widgetOrder, order);
	});

	it("reports a rejected line mutation back to the editor", async () => {
		const start = config({ lines: lines({ line1: ["path"] }) });
		let accepted: boolean | undefined;
		const { deps } = depsFor(start, ["Widgets", "Done"], {
			editWidgets: async (_title, _all, _lines, _order, onChange) => {
				accepted = onChange(lines({ line4: ["state"] }), lines({ line1: ["path"], line4: ["state"] }));
				return undefined;
			},
		});
		deps.applyConfig = () => ({ ok: false, error: "save failed" });
		await runStatuslineConfigurator(deps, ["path", "state"]);
		assert.equal(accepted, false);
	});

	it("removes Layout from Appearance and applies separator", async () => {
		const mainChoices = ["Appearance", "Done"];
		const appearanceChoices = ["Widget separator", "Back"];
		let appearanceItems: string[] = [];
		const { deps, getConfig } = depsFor(config(), mainChoices, {
			select: async (title, items) => {
				if (title.startsWith("Appearance")) {
					appearanceItems = items;
					return appearanceChoices.shift();
				}
				if (title.includes("Widget separator")) return "bar";
				return undefined;
			},
		});
		await runStatuslineConfigurator(deps, ["path"]);
		assert.equal(appearanceItems.includes("Layout"), false);
		assert.ok(appearanceItems.includes("Widget separator"));
		assert.equal(getConfig().separator, "bar");
	});

	it("toggles run notification without changing widget lines", async () => {
		const start = config({ lines: lines({ line3: ["path", "runTtft"] }), runNotification: false });
		const { deps, getConfig } = depsFor(start, ["Run notification: off", "Done"]);
		await runStatuslineConfigurator(deps, ["path", "runTtft"]);
		assert.equal(getConfig().runNotification, true);
		assert.deepEqual(getConfig().lines, start.lines);
	});

	it("requires confirmation before resetting", async () => {
		let resets = 0;
		const { deps } = depsFor(config(), ["Reset to defaults", "Done"], { confirm: async () => false });
		deps.resetConfig = () => { resets += 1; return { ok: true, value: undefined }; };
		await runStatuslineConfigurator(deps, ["path"]);
		assert.equal(resets, 0);
	});

	it("applies the minimal profile while preserving run notification", async () => {
		const start = config({
			lines: lines({ line2: ["path", "state"] }),
			iconMode: "emoji",
			minimal: false,
			runNotification: true,
		});
		const mainChoices = ["Appearance", "Done"];
		const appearanceChoices = ["Minimal profile", "Back"];
		const { deps, getConfig } = depsFor(start, mainChoices, {
			select: async (title) => {
				if (title.startsWith("Appearance")) return appearanceChoices.shift();
				if (title.includes("Minimal profile")) return "on";
				return undefined;
			},
		});
		await runStatuslineConfigurator(deps, ["path"]);
		assert.deepEqual(getConfig().lines.line0, ["model", "mode", "fast"]);
		assert.equal(getConfig().minimal, true);
		assert.equal(getConfig().iconMode, "plain");
		assert.equal(getConfig().runNotification, true);
	});
});
