import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadTaskboardActivityMode, loadTaskboardDefault, updateTaskboardConfig } from "../lib/config.ts";

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

	it("refuses malformed config without overwriting it", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-config-bad-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, "{ bad");
		assert.equal(updateTaskboardConfig(agentDir, "full").ok, false);
		assert.equal(readFileSync(path, "utf8"), "{ bad");
	});
});
