import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { mergeConfig, resolveConfigPaths, updateModeConfig } from "../lib/config.ts";

describe("resolveConfigPaths", () => {
	it("ignores project config when the project is not trusted", () => {
		assert.deepEqual(resolveConfigPaths("/workspace", "/agent", false, ".pi"), [
			"/agent/terrific.json",
		]);
	});

	it("uses the configured project directory name for trusted projects", () => {
		assert.deepEqual(resolveConfigPaths("/workspace", "/agent", true, ".custom-pi"), [
			"/agent/terrific.json",
			"/workspace/.custom-pi/terrific.json",
		]);
	});

});

describe("mode config writer", () => {
	it("atomically patches mode while preserving sibling and future keys", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mode-config-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({ fast: { enabled: true }, mode: { future: "keep" } }));

		const result = updateModeConfig(agentDir, (mode) => {
			mode.default = "ask";
			mode.persistPerSession = false;
		});
		assert.equal(result.ok, true);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			fast: { enabled: true },
			mode: { future: "keep", default: "ask", persistPerSession: false },
		});
	});

	it("refuses malformed terrific.json without replacing it", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mode-config-bad-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, "{ bad");
		const result = updateModeConfig(agentDir, (mode) => { mode.default = "ask"; });
		assert.equal(result.ok, false);
		assert.equal(readFileSync(path, "utf8"), "{ bad");
	});
});

describe("mergeConfig", () => {
	it("bounds numeric settings", () => {
		const config = mergeConfig({
			context: { topEntries: Number.MAX_SAFE_INTEGER },
			btw: {
				maxContextTokens: Number.MAX_SAFE_INTEGER,
				maxOutputTokens: Number.MAX_SAFE_INTEGER,
			},
		});

		assert.ok(config.context.topEntries <= 100);
		assert.ok(config.btw.maxContextTokens <= 1_000_000);
		assert.ok(config.btw.maxOutputTokens <= 100_000);
	});
});
