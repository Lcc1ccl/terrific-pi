import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	readSettingsDefaults,
	restoreSettingsFile,
	snapshotSettingsFile,
	snapshotToRestoreDefaults,
	writeSettingsDefaults,
} from "../lib/settings-defaults.ts";

describe("writeSettingsDefaults", () => {
	it("creates settings.json with only the three defaults when missing", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-settings-"));
		const result = writeSettingsDefaults(
			{
				defaultProvider: "grok",
				defaultModel: "grok-4.5",
				defaultThinkingLevel: "high",
			},
			agentDir,
		);
		assert.equal(result.ok, true);
		const json = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.equal(json.defaultProvider, "grok");
		assert.equal(json.defaultModel, "grok-4.5");
		assert.equal(json.defaultThinkingLevel, "high");
	});

	it("preserves unrelated settings keys", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-settings-keep-"));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify(
				{
					theme: "dark",
					packages: ["npm:demo"],
					defaultProvider: "old",
					defaultModel: "old-model",
				},
				null,
				2,
			),
		);

		const result = writeSettingsDefaults(
			{
				defaultProvider: "openai",
				defaultModel: "gpt-5.4-mini",
				defaultThinkingLevel: "low",
			},
			agentDir,
		);
		assert.equal(result.ok, true);
		const json = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.equal(json.theme, "dark");
		assert.deepEqual(json.packages, ["npm:demo"]);
		assert.equal(json.defaultProvider, "openai");
		assert.equal(json.defaultModel, "gpt-5.4-mini");
		assert.equal(json.defaultThinkingLevel, "low");
	});

	it("fails on corrupt JSON without clobbering", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-settings-bad-"));
		const path = join(agentDir, "settings.json");
		writeFileSync(path, "{not-json");
		const before = readFileSync(path, "utf8");
		const result = writeSettingsDefaults(
			{
				defaultProvider: "x",
				defaultModel: "y",
				defaultThinkingLevel: "off",
			},
			agentDir,
		);
		assert.equal(result.ok, false);
		assert.equal(readFileSync(path, "utf8"), before);
	});

	it("reads complete defaults only", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-settings-read-"));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "openai",
				defaultModel: "gpt-5.6-sol",
				defaultThinkingLevel: "medium",
				theme: "dark",
			}),
		);
		assert.deepEqual(readSettingsDefaults(agentDir), {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium",
			incomplete: false,
		});
	});

	it("marks incomplete when thinking missing", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-settings-incomplete-"));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "openai",
				defaultModel: "gpt-5.6-sol",
			}),
		);
		const snap = readSettingsDefaults(agentDir);
		assert.equal(snap?.incomplete, true);
		assert.equal(snap?.defaultThinkingLevel, undefined);
		const restored = snapshotToRestoreDefaults(snap!, "low");
		assert.equal(restored.usedThinkingFallback, true);
		assert.equal(restored.defaults.defaultThinkingLevel, "low");
	});

	it("restores only model defaults while preserving concurrent sibling updates", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-settings-concurrent-"));
		const path = join(agentDir, "settings.json");
		writeFileSync(path, JSON.stringify({
			defaultProvider: "openai",
			defaultModel: "gpt-old",
			defaultThinkingLevel: "medium",
			theme: "dark",
			packages: ["old"],
		}), "utf8");
		const snapshot = snapshotSettingsFile(agentDir);
		assert.equal(snapshot.ok, true);
		if (!snapshot.ok) return;
		writeFileSync(path, JSON.stringify({
			defaultProvider: "grok",
			defaultModel: "grok-4.5",
			defaultThinkingLevel: "high",
			theme: "light",
			packages: ["new"],
		}), "utf8");
		const result = restoreSettingsFile(snapshot, {
			defaultProvider: "grok",
			defaultModel: "grok-4.5",
			defaultThinkingLevel: "high",
		});
		assert.equal(result.ok, true);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			defaultProvider: "openai",
			defaultModel: "gpt-old",
			defaultThinkingLevel: "medium",
			theme: "light",
			packages: ["new"],
		});
	});

	it("refuses to overwrite concurrent changes to the model defaults", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-settings-conflict-"));
		const path = join(agentDir, "settings.json");
		writeFileSync(path, JSON.stringify({ defaultProvider: "openai", defaultModel: "old", defaultThinkingLevel: "medium" }), "utf8");
		const snapshot = snapshotSettingsFile(agentDir);
		assert.equal(snapshot.ok, true);
		if (!snapshot.ok) return;
		writeFileSync(path, JSON.stringify({ defaultProvider: "external", defaultModel: "new", defaultThinkingLevel: "low" }), "utf8");
		const result = restoreSettingsFile(snapshot, {
			defaultProvider: "grok",
			defaultModel: "grok-4.5",
			defaultThinkingLevel: "high",
		});
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /changed concurrently/i);
		assert.equal((JSON.parse(readFileSync(path, "utf8")) as { defaultProvider: string }).defaultProvider, "external");
	});

	it("restores absent defaults without deleting concurrent sibling settings", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-settings-missing-"));
		const path = join(agentDir, "settings.json");
		const snapshot = snapshotSettingsFile(agentDir);
		assert.equal(snapshot.ok, true);
		if (!snapshot.ok) return;
		const expected = { defaultProvider: "grok", defaultModel: "grok-4.5", defaultThinkingLevel: "high" as const };
		writeFileSync(path, JSON.stringify({ ...expected, theme: "light" }), "utf8");
		assert.equal(restoreSettingsFile(snapshot, expected).ok, true);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { theme: "light" });
	});

	it("fails closed when the original settings snapshot is malformed", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-settings-corrupt-"));
		const path = join(agentDir, "settings.json");
		writeFileSync(path, "{ not valid json\n", "utf8");
		const snapshot = snapshotSettingsFile(agentDir);
		assert.equal(snapshot.ok, true);
		if (!snapshot.ok) return;
		const expected = { defaultProvider: "grok", defaultModel: "grok-4.5", defaultThinkingLevel: "high" as const };
		writeFileSync(path, JSON.stringify(expected), "utf8");
		const result = restoreSettingsFile(snapshot, expected);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /malformed/i);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), expected);
	});
});
