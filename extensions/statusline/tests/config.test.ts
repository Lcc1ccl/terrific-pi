import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	cloneMinimalProfile,
	DEFAULT_CONFIG,
	isMinimalProfile,
	loadStatuslineConfigResult,
	mergeStatuslineConfig,
	MINIMAL_PROFILE,
	MINIMAL_WIDGETS,
	nextWidgetGroup,
	resolveConfigPath,
	resolveRuntimeConfigPath,
	resolveWidgetGroup,
	saveStatuslineConfig,
	WIDGET_IDS,
	withWidgetGroupOverride,
} from "../lib/config.ts";

function loadConfig(path: string) {
	const result = loadStatuslineConfigResult(path);
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

describe("mergeStatuslineConfig", () => {
	it("keeps defaults for empty input", () => {
		assert.deepEqual(mergeStatuslineConfig({}), DEFAULT_CONFIG);
	});

	it("defaults to the dot separator with numeric spacing", () => {
		assert.equal(DEFAULT_CONFIG.separator, "dot");
		assert.equal(DEFAULT_CONFIG.spacing, 1);
	});

	it("defaults layout single and iconMode emoji without auto-inserting new widgets", () => {
		assert.equal(DEFAULT_CONFIG.layout, "single");
		assert.equal(DEFAULT_CONFIG.iconMode, "emoji");
		assert.equal(DEFAULT_CONFIG.widgets.includes("quota"), false);
		assert.equal(DEFAULT_CONFIG.widgets.includes("environment"), false);
		assert.equal(DEFAULT_CONFIG.widgets.includes("toolActivity"), false);
		assert.equal(DEFAULT_CONFIG.toolActivityMode, "compact");
		assert.equal(DEFAULT_CONFIG.widgets.includes("mode"), true);
		assert.equal(WIDGET_IDS.includes("auxUsage" as never), false);
	});

	it("defines a minimal profile around pi footer core + light extras", () => {
		assert.deepEqual(MINIMAL_WIDGETS, [
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
		assert.equal(MINIMAL_PROFILE.layout, "single");
		assert.equal(MINIMAL_PROFILE.iconMode, "plain");
		assert.equal(MINIMAL_PROFILE.minimal, true);
		assert.equal(MINIMAL_PROFILE.contextMode, "used");
		assert.equal(MINIMAL_PROFILE.toolActivityMode, "compact");
		assert.equal(isMinimalProfile(cloneMinimalProfile()), true);
		assert.equal(isMinimalProfile(DEFAULT_CONFIG), false);
		assert.equal(
			isMinimalProfile({ ...cloneMinimalProfile(), widgets: ["model", "state"] }),
			false,
		);
	});

	it("registers fast as a dedicated widget and enables it by default", () => {
		assert.equal(WIDGET_IDS.indexOf("fast"), WIDGET_IDS.indexOf("mode") + 1);
		assert.equal(DEFAULT_CONFIG.widgets.indexOf("mode"), DEFAULT_CONFIG.widgets.indexOf("model") + 1);
		assert.equal(DEFAULT_CONFIG.widgets.indexOf("fast"), DEFAULT_CONFIG.widgets.indexOf("mode") + 1);
	});

	it("merges widget group overrides and drops no-op defaults", () => {
		const merged = mergeStatuslineConfig({
			widgetGroups: { tokens: "activity", path: "project", nope: "usage" },
		});
		assert.deepEqual(merged.widgetGroups, { tokens: "activity" });
		assert.equal(resolveWidgetGroup("tokens", merged.widgetGroups), "activity");
		assert.equal(resolveWidgetGroup("path", merged.widgetGroups), "project");
		assert.equal(nextWidgetGroup("project"), "usage");
		assert.deepEqual(withWidgetGroupOverride({ tokens: "activity" }, "tokens", "usage"), undefined);
	});

	it("filters unknown widgets and applies known options", () => {
		const merged = mergeStatuslineConfig({
			widgets: ["path", "nope", "cost", "contextBar", "quota"],
			layout: "stacked",
			iconMode: "plain",
			contextMode: "used",
			contextBarWidth: 8,
			minimal: true,
			separator: "bar",
			spacing: 2,
			toolActivityMode: "compact",
		});
		assert.deepEqual(merged.widgets, ["path", "cost", "contextBar", "quota"]);
		assert.equal(merged.layout, "stacked");
		assert.equal(merged.iconMode, "plain");
		assert.equal(merged.contextMode, "used");
		assert.equal(merged.contextBarWidth, 8);
		assert.equal(merged.minimal, true);
		assert.equal(merged.separator, "bar");
		assert.equal(merged.spacing, 2);
		assert.equal(merged.toolActivityMode, "compact");
	});

	it("rejects arbitrary separator strings", () => {
		assert.equal(mergeStatuslineConfig({ separator: "│" }).separator, "dot");
		assert.equal(mergeStatuslineConfig({ separator: " | " }).separator, "dot");
	});

	it("deduplicates widgets and rejects fractional context widths", () => {
		const merged = mergeStatuslineConfig({
			widgets: ["path", "cost", "path", "cost"],
			contextBarWidth: 8.9,
		});
		assert.deepEqual(merged.widgets, ["path", "cost"]);
		assert.equal(merged.contextBarWidth, DEFAULT_CONFIG.contextBarWidth);
	});

	it("falls back for illegal layout and iconMode", () => {
		const merged = mergeStatuslineConfig({ layout: "grid", iconMode: "ascii" });
		assert.equal(merged.layout, "single");
		assert.equal(merged.iconMode, "emoji");
	});

	it("falls back for non-integer or out-of-range spacing", () => {
		for (const spacing of [-1, 5, 1.5, "1"]) {
			const merged = mergeStatuslineConfig({ spacing });
			assert.equal(merged.spacing, 1);
		}
	});

	it("falls back when widgets become empty", () => {
		const merged = mergeStatuslineConfig({ widgets: ["nope"] });
		assert.deepEqual(merged.widgets, DEFAULT_CONFIG.widgets);
	});
});

describe("loadStatuslineConfigResult", () => {
	it("loads partial json and merges defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
		const file = join(dir, "settings.json");
		writeFileSync(file, JSON.stringify({ widgets: ["path", "cost"], minimal: true }), "utf8");
		const loaded = loadConfig(file);
		assert.deepEqual(loaded.widgets, ["path", "cost"]);
		assert.equal(loaded.minimal, true);
		assert.equal(loaded.contextMode, DEFAULT_CONFIG.contextMode);
		assert.equal(loaded.layout, "single");
		assert.equal(loaded.iconMode, "emoji");
		assert.equal(loaded.separator, "dot");
		assert.equal(loaded.spacing, 1);
	});

	it("returns defaults for a missing file", () => {
		assert.deepEqual(loadConfig("/tmp/does-not-exist-pi-statusline.json"), DEFAULT_CONFIG);
	});

	it("rejects a non-object JSON root", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
		const file = join(dir, "array.json");
		writeFileSync(file, "[]", "utf8");

		const result = loadStatuslineConfigResult(file);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /root must be a JSON object/i);
	});

	it("reports invalid JSON instead of treating it as a successful reload", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
		const file = join(dir, "bad.json");
		writeFileSync(file, "{not-json", "utf8");

		const result = loadStatuslineConfigResult(file);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /failed to load.*bad\.json/i);
	});
});

describe("resolveConfigPath", () => {
	it("prefers explicit path, then env, then default under agent dir", () => {
		assert.equal(resolveConfigPath({ explicit: "/tmp/a.json", envPath: "/tmp/b.json", agentDir: "/home/x/.pi/agent" }), "/tmp/a.json");
		assert.equal(resolveConfigPath({ envPath: "/tmp/b.json", agentDir: "/home/x/.pi/agent" }), "/tmp/b.json");
		assert.equal(resolveConfigPath({ agentDir: "/home/x/.pi/agent" }), "/home/x/.pi/agent/statusline.json");
	});

	it("uses PI_CODING_AGENT_DIR for the runtime default", () => {
		const previousConfig = process.env.PI_STATUSLINE_CONFIG;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousLegacyDir = process.env.PI_AGENT_DIR;
		try {
			delete process.env.PI_STATUSLINE_CONFIG;
			process.env.PI_CODING_AGENT_DIR = "/tmp/pi-official-agent";
			process.env.PI_AGENT_DIR = "/tmp/pi-legacy-agent";
			assert.equal(resolveRuntimeConfigPath(), "/tmp/pi-official-agent/statusline.json");
		} finally {
			if (previousConfig === undefined) delete process.env.PI_STATUSLINE_CONFIG;
			else process.env.PI_STATUSLINE_CONFIG = previousConfig;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousLegacyDir === undefined) delete process.env.PI_AGENT_DIR;
			else process.env.PI_AGENT_DIR = previousLegacyDir;
		}
	});
});

describe("saveStatuslineConfig", () => {
	it("writes pretty json and round-trips through load", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
		const nested = join(dir, "nested", "statusline.json");
		const config = {
			widgets: ["path", "cost"] as const,
			layout: "stacked" as const,
			iconMode: "plain" as const,
			contextMode: "used" as const,
			contextBarWidth: 8,
			minimal: true,
			separator: "bar" as const,
			spacing: 2,
		};

		saveStatuslineConfig(nested, { ...config, widgets: [...config.widgets] });

		const raw = readFileSync(nested, "utf8");
		assert.equal(raw.endsWith("\n"), true);
		assert.deepEqual(JSON.parse(raw), {
			widgets: ["path", "cost"],
			layout: "stacked",
			iconMode: "plain",
			contextMode: "used",
			contextBarWidth: 8,
			minimal: true,
			separator: "bar",
			spacing: 2,
			toolActivityMode: "compact",
		});
		assert.deepEqual(loadConfig(nested), {
			widgets: ["path", "cost"],
			layout: "stacked",
			iconMode: "plain",
			contextMode: "used",
			contextBarWidth: 8,
			minimal: true,
			separator: "bar",
			spacing: 2,
			toolActivityMode: "compact",
		});
	});
});
