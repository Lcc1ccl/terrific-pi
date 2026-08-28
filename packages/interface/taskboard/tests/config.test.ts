import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	loadTaskboardActivityMode,
	loadTaskboardConfig,
	loadTaskboardDefault,
	updateTaskboardConfig,
} from "../lib/config.ts";

describe("taskboard global config", () => {
	it("prefers taskboard config over legacy processView", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-config-precedence-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({
			taskboard: { defaultViewMode: "full", activityMode: "off" },
			processView: { defaultViewMode: "off", activityMode: "task" },
		}));
		assert.equal(loadTaskboardDefault(agentDir), "full");
		assert.equal(loadTaskboardActivityMode(agentDir), "off");
	});

	it("falls back to legacy processView when taskboard is absent", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-config-legacy-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({ processView: { defaultViewMode: "off", activityMode: "task" } }));
		assert.equal(loadTaskboardDefault(agentDir), "off");
		assert.equal(loadTaskboardActivityMode(agentDir), "task");
	});

	it("atomically migrates the full legacy object on a config write", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-config-migrate-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({ fast: { enabled: true }, processView: { activityMode: "task", future: "keep" } }));
		const result = updateTaskboardConfig(agentDir, "off");
		assert.equal(result.ok, true);
		assert.equal(loadTaskboardDefault(agentDir), "off");
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			fast: { enabled: true },
			taskboard: { activityMode: "task", future: "keep", defaultViewMode: "off" },
		});
	});

	it("merges legacy unknown fields when both config sections exist", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-config-dual-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({
			taskboard: { activityMode: "off", canonicalOnly: true },
			processView: { activityMode: "task", legacyOnly: true },
		}));
		const result = updateTaskboardConfig(agentDir, "full");
		assert.equal(result.ok, true);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			taskboard: { activityMode: "off", canonicalOnly: true, legacyOnly: true, defaultViewMode: "full" },
		});
	});

	it("defaults activity mode to full and accepts only supported values", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-config-activity-"));
		const path = join(agentDir, "terrific.json");
		assert.equal(loadTaskboardActivityMode(agentDir), "full");
		writeFileSync(path, JSON.stringify({ taskboard: { activityMode: "task" } }));
		assert.equal(loadTaskboardActivityMode(agentDir), "task");
		writeFileSync(path, JSON.stringify({ taskboard: { activityMode: "unexpected" } }));
		assert.equal(loadTaskboardActivityMode(agentDir), "full");
	});

	it("loads panel line budgets and strictly validates Pi KeyId shortcuts", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-config-panel-"));
		const path = join(agentDir, "terrific.json");
		assert.deepEqual(loadTaskboardConfig(agentDir), {
			activityMode: "full",
			maxPanelLines: 15,
			toggleShortcut: "shift+alt+o",
		});

		writeFileSync(path, JSON.stringify({ taskboard: { maxPanelLines: 8, toggleShortcut: "ctrl+shift+p" } }));
		assert.deepEqual(loadTaskboardConfig(agentDir), {
			activityMode: "full",
			maxPanelLines: 8,
			toggleShortcut: "ctrl+shift+p",
		});

		writeFileSync(path, JSON.stringify({ taskboard: { maxPanelLines: 20, toggleShortcut: "off" } }));
		assert.deepEqual(loadTaskboardConfig(agentDir), {
			activityMode: "full",
			maxPanelLines: 20,
			toggleShortcut: undefined,
		});

		writeFileSync(path, JSON.stringify({ taskboard: { maxPanelLines: 7, toggleShortcut: "ctrl+ctrl+x" } }));
		assert.deepEqual(loadTaskboardConfig(agentDir), {
			activityMode: "full",
			maxPanelLines: 15,
			toggleShortcut: "shift+alt+o",
			invalidToggleShortcut: "ctrl+ctrl+x",
		});
	});

	it("accepts the full documented KeyId base-key set and rejects malformed values", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-config-keyid-"));
		const path = join(agentDir, "terrific.json");
		for (const shortcut of ["a", "f12", "pageUp", "+", "ctrl++", "super+alt+left", "ctrl+shift+alt+x"]) {
			writeFileSync(path, JSON.stringify({ taskboard: { toggleShortcut: shortcut } }));
			assert.equal(loadTaskboardConfig(agentDir).toggleShortcut, shortcut);
		}
		for (const shortcut of ["", "CTRL+x", "ctrl+", "ctrl+ctrl+x", "meta+x", "f13", "pageup", "ctrl+x+y"]) {
			writeFileSync(path, JSON.stringify({ taskboard: { toggleShortcut: shortcut } }));
			const loaded = loadTaskboardConfig(agentDir);
			assert.equal(loaded.toggleShortcut, "shift+alt+o");
			assert.equal(loaded.invalidToggleShortcut, shortcut);
		}
	});

	it("refuses malformed config without overwriting it", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-config-bad-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, "{ bad");
		assert.equal(updateTaskboardConfig(agentDir, "full").ok, false);
		assert.equal(readFileSync(path, "utf8"), "{ bad");
	});
});
