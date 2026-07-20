import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
	defaultProjectSlug,
	describeOutputMode,
	loadDocsflowConfig,
	normalizeVaultRoot,
	resolveDocsflowOutputRoot,
	resolveLocalOutputRoot,
	resolveVaultOutputRoot,
	updateDocsflowConfig,
	updateDocsflowStageOverride,
	vaultConfigReminder,
} from "../lib/vault.ts";

describe("vault config", () => {
	test("defaults vaultEnabled=false and local output under cwd/docsflow", () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-cfg-"));
		const config = loadDocsflowConfig(agentDir);
		assert.equal(config.vaultEnabled, false);
		assert.equal(config.configReminder, true);
		const project = mkdtempSync(path.join(tmpdir(), "proj-"));
		const out = resolveDocsflowOutputRoot({
			config,
			projectRoot: project,
			projectSlug: "anything",
		});
		assert.equal(out, resolveLocalOutputRoot(project));
		assert.equal(out, path.join(project, "docsflow"));
		assert.match(vaultConfigReminder(config), /OFF \(default\)/);
	});

	test("vaultEnabled=true resolves under vault projectBase", () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-cfg-on-"));
		const vault = mkdtempSync(path.join(tmpdir(), "vault-"));
		mkdirSync(path.join(vault, "2_Career/01-INDIE/开发"), { recursive: true });
		writeFileSync(
			path.join(agentDir, "terrific.json"),
			JSON.stringify({
				docsflow: {
					vaultEnabled: true,
					vaultRoot: vault,
					projectBase: "2_Career/01-INDIE/开发",
				},
			}),
		);
		const config = loadDocsflowConfig(agentDir);
		assert.equal(config.vaultEnabled, true);
		const out = resolveVaultOutputRoot(config, "terrific-pi");
		assert.equal(out, path.join(vault, "2_Career/01-INDIE/开发/terrific-pi/docsflow"));
		assert.match(describeOutputMode(config, out), /^vault:/);
		assert.match(vaultConfigReminder(config), /ON/);
	});

	test("normalizes windows drive paths", () => {
		assert.equal(normalizeVaultRoot("G:\\Mindriver"), path.resolve("/mnt/g/Mindriver"));
		assert.equal(defaultProjectSlug("/tmp/foo/bar"), "bar");
	});

	test("rejects a vault project base that escapes the configured vault", () => {
		const vault = mkdtempSync(path.join(tmpdir(), "vault-safe-base-"));
		assert.throws(
			() => resolveVaultOutputRoot({
				vaultEnabled: true,
				configReminder: false,
				vaultRoot: vault,
				projectBase: "../outside",
				stageOverrides: {},
			}, "project"),
			/projectBase/i,
		);
	});

	test("refuses to persist an unsafe vault project base", () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-cfg-unsafe-base-"));
		assert.throws(
			() => updateDocsflowConfig(agentDir, { projectBase: "../outside" }),
			/projectBase/i,
		);
	});

	test("updateDocsflowConfig persists configReminder off", () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-cfg-remind-"));
		writeFileSync(
			path.join(agentDir, "terrific.json"),
			JSON.stringify({ keep: true, docsflow: { vaultEnabled: false } }),
		);
		const updated = updateDocsflowConfig(agentDir, { configReminder: false });
		assert.equal(updated.configReminder, false);
		const reloaded = loadDocsflowConfig(agentDir);
		assert.equal(reloaded.configReminder, false);
		const raw = JSON.parse(readFileSync(path.join(agentDir, "terrific.json"), "utf8")) as {
			keep: boolean;
			docsflow: { configReminder: boolean; vaultEnabled: boolean };
		};
		assert.equal(raw.keep, true);
		assert.equal(raw.docsflow.configReminder, false);
		assert.equal(raw.docsflow.vaultEnabled, false);
	});

	test("merges validated stage overrides without replacing sibling stage settings", () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-cfg-stage-"));
		writeFileSync(path.join(agentDir, "terrific.json"), JSON.stringify({
			docsflow: {
				stageOverrides: {
					research: { model: "openai/research", thinking: "high", timeoutMs: 45_000, future: "keep" },
					product: { timeoutMs: 60_000 },
				},
			},
		}), "utf8");

		const updated = updateDocsflowStageOverride(agentDir, "research", { timeoutMs: 90_000 });
		assert.equal(updated.stageOverrides.research?.model, "openai/research");
		assert.equal(updated.stageOverrides.research?.thinking, "high");
		assert.equal(updated.stageOverrides.research?.timeoutMs, 90_000);
		assert.equal(updated.stageOverrides.product?.timeoutMs, 60_000);
		const raw = JSON.parse(readFileSync(path.join(agentDir, "terrific.json"), "utf8"));
		assert.equal(raw.docsflow.stageOverrides.research.future, "keep");
	});

	test("keeps a 15-minute stage timeout override", () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-cfg-timeout-"));
		writeFileSync(path.join(agentDir, "terrific.json"), JSON.stringify({
			docsflow: { stageOverrides: { research: { timeoutMs: 900_000 } } },
		}), "utf8");

		assert.equal(loadDocsflowConfig(agentDir).stageOverrides.research?.timeoutMs, 900_000);
	});

	test("refuses to write while the shared config lock is held", () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-cfg-lock-"));
		const configPath = path.join(agentDir, "terrific.json");
		writeFileSync(configPath, JSON.stringify({ fast: { enabled: true } }), "utf8");
		writeFileSync(`${configPath}.lock`, "owned", "utf8");

		assert.throws(() => updateDocsflowConfig(agentDir, { configReminder: false }), /lock/i);
		assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { fast: { enabled: true } });
	});

	test("refuses to overwrite malformed shared config", () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-cfg-corrupt-"));
		const configPath = path.join(agentDir, "terrific.json");
		writeFileSync(configPath, "{ bad", "utf8");

		assert.throws(
			() => updateDocsflowConfig(agentDir, { configReminder: false }),
			/Failed to parse terrific\.json/,
		);
		assert.equal(readFileSync(configPath, "utf8"), "{ bad");
	});
});
