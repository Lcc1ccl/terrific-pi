import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig, mergeConfig, resolveConfigPaths, updateBtwConfig } from "../lib/config.ts";

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

describe("BTW config writer", () => {
	it("updates only maxContextTokens and preserves auxiliary routing", () => {
		const root = mkdtempSync(join(tmpdir(), "btw-config-write-"));
		const path = join(root, "terrific.json");
		writeFileSync(path, JSON.stringify({
			auxiliary: { tasks: { btw: { model: "openai/pinned" } } },
			btw: { future: "keep" },
		}));
		const result = updateBtwConfig(path, (btw) => { btw.maxContextTokens = 12_345; });
		assert.equal(result.ok, true);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			auxiliary: { tasks: { btw: { model: "openai/pinned" } } },
			btw: { future: "keep", maxContextTokens: 12_345 },
		});
	});
});

describe("mergeConfig", () => {
	it("resolves the auxiliary BTW route with bounded fallbacks", () => {
		const config = mergeConfig({
			auxiliary: {
				default: { model: "openai/gpt-mini", thinking: "off", timeoutMs: 70_000, maxOutputTokens: 3000 },
				tasks: { btw: { model: "openai/gpt-btw", thinking: "low", timeoutMs: 999_999, fallbackModels: ["openai/gpt-mini", "bad", "openai/gpt-mini"] } },
			},
		});
		assert.deepEqual(config.auxiliaryBtw, {
			model: "openai/gpt-btw",
			thinking: "low",
			timeoutMs: 600_000,
			maxOutputTokens: 3000,
			fallbackModels: ["openai/gpt-mini"],
		});
	});

	it("uses the current model when the BTW auxiliary route is disabled", () => {
		const config = mergeConfig({
			auxiliary: {
				default: { model: "openai/default", fallbackModels: ["openai/default-fallback"] },
				tasks: {
					btw: {
						useAuxiliary: false,
						model: "openai/saved-btw",
						fallbackModels: ["openai/saved-fallback"],
					},
				},
			},
		});
		assert.equal(config.auxiliaryBtw?.model, "current");
		assert.deepEqual(config.auxiliaryBtw?.fallbackModels, []);
	});

	it("uses only the global auxiliary route while retaining trusted project legacy settings", () => {
		const root = mkdtempSync(join(tmpdir(), "btw-config-"));
		const agent = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agent);
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(agent, "terrific.json"), JSON.stringify({ auxiliary: { tasks: { btw: { model: "openai/global" } } } }));
		writeFileSync(join(project, ".pi", "terrific.json"), JSON.stringify({ btw: { maxContextTokens: 1234 }, auxiliary: { tasks: { btw: { model: "openai/project" } } } }));
		const { config } = loadConfig(project, agent, true, ".pi");
		assert.equal(config.auxiliaryBtw?.model, "openai/global");
		assert.equal(config.btw.maxContextTokens, 1234);
	});

	it("keeps current-model behavior when no auxiliary config exists", () => {
		assert.equal(mergeConfig({ btw: { thinking: "high" } }).auxiliaryBtw, undefined);
	});

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
