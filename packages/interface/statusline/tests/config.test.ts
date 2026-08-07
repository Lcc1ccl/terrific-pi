import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	cloneMinimalProfile,
	DEFAULT_CONFIG,
	enabledWidgets,
	hasWidget,
	isMinimalProfile,
	loadStatuslineConfigResult,
	mergeStatuslineConfig,
	MINIMAL_PROFILE,
	MINIMAL_WIDGETS,
	resolveConfigPath,
	resolveRuntimeConfigPath,
	saveStatuslineConfig,
	widgetLineOf,
	WIDGET_IDS,
} from "../lib/config.ts";
import type { StatuslineConfig } from "../lib/types.ts";

function loadConfig(path: string): StatuslineConfig {
	const result = loadStatuslineConfigResult(path);
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

describe("mergeStatuslineConfig", () => {
	it("uses line0-line4 as the only widget source and keeps the first duplicate", () => {
		const merged = mergeStatuslineConfig({
			lines: {
				line0: ["tokens", "model", "nope"],
				line1: ["path", "tokens"],
				line2: [],
				line3: ["state"],
				line4: [],
			},
			widgets: ["cost"],
			layout: "stacked",
			widgetGroups: { path: "activity" },
		});

		assert.deepEqual(merged.lines, {
			line0: ["tokens", "model"],
			line1: ["path"],
			line2: [],
			line3: ["state"],
			line4: [],
		});
		assert.equal(Object.hasOwn(merged, "widgets"), false);
		assert.equal(Object.hasOwn(merged, "layout"), false);
		assert.equal(Object.hasOwn(merged, "widgetGroups"), false);
	});

	it("keeps defaults for empty input without sharing line arrays", () => {
		const merged = mergeStatuslineConfig({});
		assert.deepEqual(merged, DEFAULT_CONFIG);
		assert.notEqual(merged.lines, DEFAULT_CONFIG.lines);
		assert.notEqual(merged.lines.line0, DEFAULT_CONFIG.lines.line0);
	});

	it("accepts partial lines and ignores unknown line names", () => {
		const merged = mergeStatuslineConfig({
			lines: { line0: ["path"], line2: ["state"], line5: ["cost"] },
		});
		assert.deepEqual(merged.lines, {
			line0: ["path"],
			line1: [],
			line2: ["state"],
			line3: [],
			line4: [],
		});
	});

	it("falls back to defaults when no line contains a valid widget", () => {
		assert.deepEqual(
			mergeStatuslineConfig({ lines: { line0: ["nope"], line1: [] } }).lines,
			DEFAULT_CONFIG.lines,
		);
	});

	it("falls back to legacy migration when lines has no valid line array", () => {
		const merged = mergeStatuslineConfig({
			lines: { line0: "bad", line5: ["path"] },
			widgets: ["state"],
			layout: "single",
		});
		assert.deepEqual(merged.lines, {
			line0: [],
			line1: ["state"],
			line2: [],
			line3: [],
			line4: [],
		});
	});

	it("applies display options and rejects invalid values", () => {
		const merged = mergeStatuslineConfig({
			lines: { line1: ["path", "contextBar", "quota"] },
			iconMode: "plain",
			contextMode: "used",
			contextBarWidth: 8,
			minimal: true,
			separator: "bar",
			spacing: 2,
			toolActivityMode: "detailed",
			runNotification: true,
		});
		assert.equal(merged.iconMode, "plain");
		assert.equal(merged.contextMode, "used");
		assert.equal(merged.contextBarWidth, 8);
		assert.equal(merged.minimal, true);
		assert.equal(merged.separator, "bar");
		assert.equal(merged.spacing, 2);
		assert.equal(merged.toolActivityMode, "detailed");
		assert.equal(merged.runNotification, true);

		for (const spacing of [-1, 5, 1.5, "1"]) {
			assert.equal(mergeStatuslineConfig({ spacing }).spacing, 1);
		}
		assert.equal(mergeStatuslineConfig({ contextBarWidth: 8.9 }).contextBarWidth, 10);
		assert.equal(mergeStatuslineConfig({ separator: "│" }).separator, "dot");
		assert.equal(mergeStatuslineConfig({ iconMode: "unknown" }).iconMode, "emoji");
	});

	it("registers independent run metric widgets without enabling them by default", () => {
		assert.equal(DEFAULT_CONFIG.runNotification, false);
		assert.equal(DEFAULT_CONFIG.toolActivityMode, "compact");
		for (const id of ["runTps", "runTtft", "runDuration", "runTokens", "runStalls", "runCostRate"] as const) {
			assert.equal(WIDGET_IDS.includes(id), true, id);
			assert.equal(hasWidget(DEFAULT_CONFIG, id), false, id);
		}
		assert.equal(WIDGET_IDS.includes("performance" as never), false);
		assert.equal(WIDGET_IDS.includes("auxUsage" as never), false);
	});

	it("defines the minimal profile as explicit editor and footer lines", () => {
		assert.deepEqual(MINIMAL_PROFILE.lines.line0, ["model", "mode", "fast"]);
		assert.deepEqual(MINIMAL_PROFILE.lines.line1, [
			"path", "session", "branch", "tokens", "cache", "cost", "context", "progress", "state",
		]);
		assert.deepEqual(MINIMAL_WIDGETS, [...MINIMAL_PROFILE.lines.line0, ...MINIMAL_PROFILE.lines.line1]);
		assert.equal(MINIMAL_PROFILE.iconMode, "plain");
		assert.equal(MINIMAL_PROFILE.minimal, true);
		assert.equal(MINIMAL_PROFILE.contextMode, "used");
		assert.equal(isMinimalProfile(cloneMinimalProfile()), true);
		assert.equal(isMinimalProfile(DEFAULT_CONFIG), false);
		const changed = cloneMinimalProfile();
		changed.lines.line1 = ["state"];
		assert.equal(isMinimalProfile(changed), false);
	});

	it("exposes flattened enablement and line lookup helpers", () => {
		const config = mergeStatuslineConfig({ lines: { line0: ["tokens"], line3: ["path", "state"] } });
		assert.deepEqual(enabledWidgets(config), ["tokens", "path", "state"]);
		assert.equal(hasWidget(config, "path"), true);
		assert.equal(hasWidget(config, "cost"), false);
		assert.equal(widgetLineOf(config.lines, "state"), "line3");
	});
});

describe("legacy widget migration", () => {
	it("moves editor metadata to line0 and preserves single-line footer order", () => {
		const merged = mergeStatuslineConfig({
			widgets: ["path", "model", "tokens", "mode", "state", "fast"],
			layout: "single",
		});
		assert.deepEqual(merged.lines, {
			line0: ["model", "mode", "fast"],
			line1: ["path", "tokens", "state"],
			line2: [],
			line3: [],
			line4: [],
		});
	});

	it("maps stacked groups and valid overrides to line1-line4", () => {
		const merged = mergeStatuslineConfig({
			widgets: ["path", "model", "tokens", "session", "state", "cost"],
			layout: "stacked",
			widgetGroups: { path: "activity", cost: "environment", nope: "project" },
		});
		assert.deepEqual(merged.lines, {
			line0: ["model"],
			line1: [],
			line2: ["tokens"],
			line3: ["session", "cost"],
			line4: ["path", "state"],
		});
	});

	it("drops removed performance and telemetry fields", () => {
		const merged = mergeStatuslineConfig({
			widgets: ["runTtft", "performance", "runTps"],
			runNotification: true,
			telemetry: { display: "notification" },
		});
		assert.deepEqual(merged.lines.line1, ["runTtft", "runTps"]);
		assert.equal(merged.runNotification, true);
		assert.equal(Object.hasOwn(merged, "telemetry"), false);
	});
});

describe("loadStatuslineConfigResult", () => {
	it("loads partial json and merges display defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
		const file = join(dir, "settings.json");
		writeFileSync(file, JSON.stringify({ lines: { line2: ["path", "cost"] }, minimal: true }), "utf8");
		const loaded = loadConfig(file);
		assert.deepEqual(loaded.lines.line2, ["path", "cost"]);
		assert.equal(loaded.minimal, true);
		assert.equal(loaded.contextMode, DEFAULT_CONFIG.contextMode);
		assert.equal(loaded.iconMode, "emoji");
		assert.equal(loaded.separator, "dot");
		assert.equal(loaded.spacing, 1);
	});

	it("returns defaults for a missing file", () => {
		assert.deepEqual(loadConfig("/tmp/does-not-exist-pi-statusline.json"), DEFAULT_CONFIG);
	});

	it("rejects non-object and malformed JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
		const array = join(dir, "array.json");
		const malformed = join(dir, "bad.json");
		writeFileSync(array, "[]", "utf8");
		writeFileSync(malformed, "{not-json", "utf8");

		const arrayResult = loadStatuslineConfigResult(array);
		assert.equal(arrayResult.ok, false);
		if (!arrayResult.ok) assert.match(arrayResult.error, /root must be a JSON object/i);
		const malformedResult = loadStatuslineConfigResult(malformed);
		assert.equal(malformedResult.ok, false);
		if (!malformedResult.ok) assert.match(malformedResult.error, /failed to load.*bad\.json/i);
	});
});

describe("resolveConfigPath", () => {
	it("prefers explicit path, then env, then agent directory", () => {
		assert.equal(resolveConfigPath({ explicit: "/tmp/a.json", envPath: "/tmp/b.json", agentDir: "/home/x/.pi/agent" }), "/tmp/a.json");
		assert.equal(resolveConfigPath({ envPath: "/tmp/b.json", agentDir: "/home/x/.pi/agent" }), "/tmp/b.json");
		assert.equal(resolveConfigPath({ agentDir: "/home/x/.pi/agent" }), "/home/x/.pi/agent/statusline.json");
	});

	it("uses PI_CODING_AGENT_DIR before the legacy directory", () => {
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
	it("writes all five lines without legacy widget fields and round-trips", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
		const nested = join(dir, "nested", "statusline.json");
		const config = mergeStatuslineConfig({
			lines: { line0: [], line1: ["path"], line4: ["state"] },
			widgetOrder: { line0: ["model", "mode", "fast"], line1: ["path"], line4: ["state"] },
			iconMode: "plain",
			contextMode: "used",
			contextBarWidth: 8,
			minimal: true,
			separator: "bar",
			spacing: 2,
			toolActivityMode: "compact",
			runNotification: true,
		});

		saveStatuslineConfig(nested, config);

		const raw = readFileSync(nested, "utf8");
		assert.equal(raw.endsWith("\n"), true);
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		assert.deepEqual(parsed.lines, {
			line0: [],
			line1: ["path"],
			line2: [],
			line3: [],
			line4: ["state"],
		});
		assert.deepEqual(parsed.widgetOrder, {
			line0: ["model", "mode", "fast"],
			line1: ["path"],
			line2: [],
			line3: [],
			line4: ["state"],
		});
		assert.equal(Object.hasOwn(parsed, "widgets"), false);
		assert.equal(Object.hasOwn(parsed, "layout"), false);
		assert.equal(Object.hasOwn(parsed, "widgetGroups"), false);
		assert.deepEqual(loadConfig(nested), config);
	});
});
