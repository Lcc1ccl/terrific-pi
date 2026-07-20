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

	it("restores the exact original settings file, including an absent or malformed file", () => {
		const missingDir = mkdtempSync(join(tmpdir(), "mp-settings-missing-"));
		const missingSnapshot = snapshotSettingsFile(missingDir);
		assert.equal(missingSnapshot.ok, true);
		if (!missingSnapshot.ok) return;
		assert.equal(missingSnapshot.exists, false);
		writeFileSync(join(missingDir, "settings.json"), JSON.stringify({ defaultModel: "changed" }), "utf8");
		assert.equal(restoreSettingsFile(missingSnapshot).ok, true);
		assert.equal(readSettingsDefaults(missingDir), undefined);

		const corruptDir = mkdtempSync(join(tmpdir(), "mp-settings-corrupt-"));
		const corruptPath = join(corruptDir, "settings.json");
		const original = "{ not valid json\n";
		writeFileSync(corruptPath, original, "utf8");
		const corruptSnapshot = snapshotSettingsFile(corruptDir);
		assert.equal(corruptSnapshot.ok, true);
		if (!corruptSnapshot.ok) return;
		writeFileSync(corruptPath, JSON.stringify({ defaultModel: "changed" }), "utf8");
		assert.equal(restoreSettingsFile(corruptSnapshot).ok, true);
		assert.equal(readFileSync(corruptPath, "utf8"), original);
	});
});
