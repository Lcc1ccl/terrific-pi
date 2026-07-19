import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
	DEFAULT_AUXILIARY_CONFIG,
	loadAuxiliaryConfig,
	mergeAuxiliaryConfig,
	parseModelRef,
	resolveAuxiliaryConfigPath,
	resolveTaskRoute,
} from "../lib/config.ts";

describe("auxiliary config", () => {
	test("loads defaults without warning when the global file is missing", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-config-missing-"));
		const loaded = loadAuxiliaryConfig(agentDir);
		assert.deepEqual(loaded.config, DEFAULT_AUXILIARY_CONFIG);
		assert.deepEqual(loaded.warnings, []);
	});

	test("uses only the global agent config path", () => {
		assert.equal(resolveAuxiliaryConfigPath("/agent"), "/agent/pi-essentials.json");
	});

	test("falls back safely on malformed JSON", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-config-bad-"));
		writeFileSync(join(agentDir, "pi-essentials.json"), "{ bad", "utf8");
		const loaded = loadAuxiliaryConfig(agentDir);
		assert.deepEqual(loaded.config, DEFAULT_AUXILIARY_CONFIG);
		assert.equal(loaded.warnings.length, 1);
		assert.match(loaded.warnings[0]!, /failed to read/i);
	});

	test("merges task routes, clamps budgets, and deduplicates fallbacks", () => {
		const loaded = mergeAuxiliaryConfig({
			auxiliary: {
				default: { timeoutMs: 2, maxOutputTokens: 999_999, maxRetries: 9 },
				tasks: {
					text_summary: {
						model: "openai/custom/model",
						fallbackModels: ["openai/fallback", "openai/fallback", "openai/custom/model", "grok/a", "grok/b", "grok/c"],
					},
				},
			},
		});
		const route = resolveTaskRoute(loaded.config, "text_summary");
		assert.equal(route.model, "openai/custom/model");
		assert.equal(route.timeoutMs, 1_000);
		assert.equal(loaded.config.default.maxOutputTokens, 128_000);
		assert.equal(route.maxOutputTokens, 3_000);
		assert.equal(route.maxRetries, 2);
		assert.deepEqual(route.fallbackModels, ["openai/fallback", "grok/a", "grok/b"]);
	});

	test("keeps invalid primary model refs unavailable instead of silently selecting current", () => {
		const loaded = mergeAuxiliaryConfig({ auxiliary: { tasks: { title_generation: { model: "not-canonical" } } } });
		const route = resolveTaskRoute(loaded.config, "title_generation");
		assert.equal(route.model, "not-canonical");
		assert.equal(parseModelRef(route.model), undefined);
	});

	test("warns and ignores credential-bearing fields", () => {
		const loaded = mergeAuxiliaryConfig({
			auxiliary: {
				apiKey: "secret",
				default: { baseUrl: "https://example.invalid", headers: { Authorization: "secret" } },
			},
		});
		assert.equal(loaded.config.default.model, DEFAULT_AUXILIARY_CONFIG.default.model);
		assert.ok(loaded.warnings.some((warning) => /apiKey/.test(warning)));
		assert.ok(loaded.warnings.some((warning) => /baseUrl/.test(warning)));
		assert.ok(loaded.warnings.some((warning) => /headers/.test(warning)));
	});

	test("parses provider/model at the first slash", () => {
		assert.deepEqual(parseModelRef("openrouter/org/model:free"), { provider: "openrouter", modelId: "org/model:free" });
		assert.equal(parseModelRef("current"), "current");
		assert.equal(parseModelRef("/missing"), undefined);
	});
});
