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
			path.join(agentDir, "pi-essentials.json"),
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

	test("updateDocsflowConfig persists configReminder off", () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-cfg-remind-"));
		writeFileSync(
			path.join(agentDir, "pi-essentials.json"),
			JSON.stringify({ keep: true, docsflow: { vaultEnabled: false } }),
		);
		const updated = updateDocsflowConfig(agentDir, { configReminder: false });
		assert.equal(updated.configReminder, false);
		const reloaded = loadDocsflowConfig(agentDir);
		assert.equal(reloaded.configReminder, false);
		const raw = JSON.parse(readFileSync(path.join(agentDir, "pi-essentials.json"), "utf8")) as {
			keep: boolean;
			docsflow: { configReminder: boolean; vaultEnabled: boolean };
		};
		assert.equal(raw.keep, true);
		assert.equal(raw.docsflow.configReminder, false);
		assert.equal(raw.docsflow.vaultEnabled, false);
	});
});
