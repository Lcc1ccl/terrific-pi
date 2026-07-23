import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
	DEFAULT_AUXILIARY_CONFIG,
	loadAuxiliaryConfig,
	mergeAuxiliaryConfig,
	parseModelRef,
	readAuxiliaryConfigSource,
	resolveAuxiliaryConfigPath,
	resolveTaskRoute,
	updateAuxiliaryConfig,
} from "../lib/config.ts";

describe("auxiliary config", () => {
	test("loads defaults without warning when the global file is missing", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-config-missing-"));
		const loaded = loadAuxiliaryConfig(agentDir);
		assert.deepEqual(loaded.config, DEFAULT_AUXILIARY_CONFIG);
		assert.deepEqual(loaded.warnings, []);
	});

	test("uses only the global agent config path", () => {
		assert.equal(resolveAuxiliaryConfigPath("/agent"), "/agent/terrific.json");
	});

	test("falls back safely on malformed JSON", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-config-bad-"));
		writeFileSync(join(agentDir, "terrific.json"), "{ bad", "utf8");
		const loaded = loadAuxiliaryConfig(agentDir);
		assert.deepEqual(loaded.config, DEFAULT_AUXILIARY_CONFIG);
		assert.equal(loaded.warnings.length, 1);
		assert.match(loaded.warnings[0]!, /failed to read/i);
	});

	test("updates only auxiliary while preserving unknown root and task fields", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-config-write-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({
			docsflow: { vaultEnabled: false },
			auxiliary: {
				futureOption: "keep",
				tasks: { custom_task: { model: "openai/custom" } },
			},
		}), "utf8");

		const updated = updateAuxiliaryConfig(agentDir, (auxiliary) => {
			auxiliary.enabled = false;
			const tasks = auxiliary.tasks as Record<string, unknown>;
			tasks.compression = { useAuxiliary: false };
		});
		assert.deepEqual(updated, { ok: true });

		const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
		assert.deepEqual(saved.docsflow, { vaultEnabled: false });
		assert.equal(saved.auxiliary.futureOption, "keep");
		assert.deepEqual(saved.auxiliary.tasks.custom_task, { model: "openai/custom" });
		assert.deepEqual(saved.auxiliary.tasks.compression, { useAuxiliary: false });
		assert.deepEqual(readAuxiliaryConfigSource(agentDir), { ok: true, value: saved.auxiliary });
		assert.match(readFileSync(path, "utf8"), /\n$/);
	});

	test("preserves existing file permissions and creates private config paths", () => {
		const root = mkdtempSync(join(tmpdir(), "aux-config-mode-"));
		const path = join(root, "terrific.json");
		writeFileSync(path, "{}\n", "utf8");
		chmodSync(path, 0o600);
		assert.deepEqual(updateAuxiliaryConfig(root, (auxiliary) => {
			auxiliary.enabled = true;
		}), { ok: true });
		assert.equal(statSync(path).mode & 0o777, 0o600);

		const newAgentDir = join(root, "new", "agent");
		assert.deepEqual(updateAuxiliaryConfig(newAgentDir, (auxiliary) => {
			auxiliary.enabled = true;
		}), { ok: true });
		assert.equal(statSync(newAgentDir).mode & 0o777, 0o700);
		assert.equal(statSync(join(newAgentDir, "terrific.json")).mode & 0o777, 0o600);
	});

	test("refuses to overwrite while another process owns the config lock", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-config-locked-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({ docsflow: { keep: true } }), "utf8");
		writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "active" }), "utf8");
		const updated = updateAuxiliaryConfig(agentDir, (auxiliary) => {
			auxiliary.enabled = false;
		});
		assert.equal(updated.ok, false);
		assert.match(updated.ok ? "" : updated.error, /another process/i);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { docsflow: { keep: true } });
	});

	test("refuses to reclaim a stale-looking lock without an atomic recovery protocol", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-config-stale-lock-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, "{}\n", "utf8");
		writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid + 1_000_000_000, createdAt: Date.now() - 60_000, token: "stale" }), "utf8");
		const updated = updateAuxiliaryConfig(agentDir, (auxiliary) => {
			auxiliary.enabled = true;
		});
		assert.equal(updated.ok, false);
		assert.equal(existsSync(`${path}.lock`), true);
		assert.equal(readFileSync(path, "utf8"), "{}\n");
	});

	test("refuses to overwrite malformed JSON", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-config-refuse-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, "{ bad", "utf8");
		const updated = updateAuxiliaryConfig(agentDir, (auxiliary) => {
			auxiliary.enabled = false;
		});
		assert.equal(updated.ok, false);
		assert.match(updated.ok ? "" : updated.error, /failed to update/i);
		assert.equal(readFileSync(path, "utf8"), "{ bad");
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

	test("routes a task through the current model when its auxiliary route is disabled", () => {
		const loaded = mergeAuxiliaryConfig({
			auxiliary: {
				tasks: {
					compression: {
						useAuxiliary: false,
						model: "openai/saved-auxiliary",
						fallbackModels: ["openai/saved-fallback"],
					},
				},
			},
		});
		assert.equal(loaded.config.tasks.compression?.useAuxiliary, false);
		assert.equal(loaded.config.tasks.compression?.model, "openai/saved-auxiliary");
		assert.deepEqual(resolveTaskRoute(loaded.config, "compression"), {
			model: "current",
			thinking: "low",
			timeoutMs: 120_000,
			maxOutputTokens: 12_000,
			maxRetries: 0,
			fallbackModels: [],
		});
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

	test("adds a bounded pilot_router task that inherits the shared default model", () => {
		assert.deepEqual(resolveTaskRoute(DEFAULT_AUXILIARY_CONFIG, "pilot_router"), {
			model: DEFAULT_AUXILIARY_CONFIG.default.model,
			thinking: "off",
			timeoutMs: 10_000,
			maxOutputTokens: 128,
			maxRetries: 0,
			fallbackModels: [],
		});
		const override = mergeAuxiliaryConfig({ auxiliary: { tasks: { pilot_router: { model: "grok/router" } } } });
		assert.equal(resolveTaskRoute(override.config, "pilot_router").model, "grok/router");
	});

	test("parses provider/model at the first slash", () => {
		assert.deepEqual(parseModelRef("openrouter/org/model:free"), { provider: "openrouter", modelId: "org/model:free" });
		assert.equal(parseModelRef("current"), "current");
		assert.equal(parseModelRef("/missing"), undefined);
	});
});
