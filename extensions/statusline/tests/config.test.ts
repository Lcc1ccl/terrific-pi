import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	DEFAULT_CONFIG,
	loadStatuslineConfig,
	mergeStatuslineConfig,
	resolveConfigPath,
	saveStatuslineConfig,
} from "../lib/config.ts";

describe("mergeStatuslineConfig", () => {
	it("keeps defaults for empty input", () => {
		assert.deepEqual(mergeStatuslineConfig({}), DEFAULT_CONFIG);
	});

	it("filters unknown widgets and applies known options", () => {
		const merged = mergeStatuslineConfig({
			widgets: ["path", "nope", "cost", "contextBar"],
			contextMode: "used",
			contextBarWidth: 8,
			minimal: true,
			separator: " | ",
		});
		assert.deepEqual(merged.widgets, ["path", "cost", "contextBar"]);
		assert.equal(merged.contextMode, "used");
		assert.equal(merged.contextBarWidth, 8);
		assert.equal(merged.minimal, true);
		assert.equal(merged.separator, " | ");
	});

	it("falls back when widgets become empty", () => {
		const merged = mergeStatuslineConfig({ widgets: ["nope"] });
		assert.deepEqual(merged.widgets, DEFAULT_CONFIG.widgets);
	});
});

describe("loadStatuslineConfig", () => {
	it("loads partial json and merges defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
		const file = join(dir, "settings.json");
		writeFileSync(file, JSON.stringify({ widgets: ["path", "cost"], minimal: true }), "utf8");
		const loaded = loadStatuslineConfig(file);
		assert.deepEqual(loaded.widgets, ["path", "cost"]);
		assert.equal(loaded.minimal, true);
		assert.equal(loaded.contextMode, DEFAULT_CONFIG.contextMode);
	});

	it("returns defaults for missing or invalid files", () => {
		assert.deepEqual(loadStatuslineConfig("/tmp/does-not-exist-pi-statusline.json"), DEFAULT_CONFIG);
		const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
		const file = join(dir, "bad.json");
		writeFileSync(file, "{not-json", "utf8");
		assert.deepEqual(loadStatuslineConfig(file), DEFAULT_CONFIG);
	});
});

describe("resolveConfigPath", () => {
	it("prefers explicit path, then env, then default under agent dir", () => {
		assert.equal(resolveConfigPath({ explicit: "/tmp/a.json", envPath: "/tmp/b.json", agentDir: "/home/x/.pi/agent" }), "/tmp/a.json");
		assert.equal(resolveConfigPath({ envPath: "/tmp/b.json", agentDir: "/home/x/.pi/agent" }), "/tmp/b.json");
		assert.equal(resolveConfigPath({ agentDir: "/home/x/.pi/agent" }), "/home/x/.pi/agent/statusline.json");
	});
});

describe("saveStatuslineConfig", () => {
	it("writes pretty json and round-trips through load", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
		const nested = join(dir, "nested", "statusline.json");
		const config = {
			widgets: ["path", "cost"] as const,
			contextMode: "used" as const,
			contextBarWidth: 8,
			minimal: true,
			separator: " | ",
		};

		saveStatuslineConfig(nested, { ...config, widgets: [...config.widgets] });

		const raw = readFileSync(nested, "utf8");
		assert.equal(raw.endsWith("\n"), true);
		assert.deepEqual(JSON.parse(raw), {
			widgets: ["path", "cost"],
			contextMode: "used",
			contextBarWidth: 8,
			minimal: true,
			separator: " | ",
		});
		assert.deepEqual(loadStatuslineConfig(nested), {
			widgets: ["path", "cost"],
			contextMode: "used",
			contextBarWidth: 8,
			minimal: true,
			separator: " | ",
		});
	});
});
