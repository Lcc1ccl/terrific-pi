import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { patchModelProfileSection } from "../lib/config-write.ts";

describe("patchModelProfileSection", () => {
	it("creates modelProfile.startup when file missing", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-terrific-"));
		const result = patchModelProfileSection({ startup: true }, agentDir);
		assert.equal(result.ok, true);
		const json = JSON.parse(readFileSync(join(agentDir, "terrific.json"), "utf8")) as {
			modelProfile: { startup: boolean };
		};
		assert.equal(json.modelProfile.startup, true);
	});

	it("preserves profiles and sibling keys", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-terrific-keep-"));
		writeFileSync(
			join(agentDir, "terrific.json"),
			JSON.stringify({
				mode: { default: "edit" },
				modelProfile: {
					startup: false,
					startupScope: "session",
					profiles: [{ id: 1, alias: "default", provider: "grok", model: "g", thinking: "high" }],
				},
			}),
		);

		const result = patchModelProfileSection({ startup: true, startupScope: "global" }, agentDir);
		assert.equal(result.ok, true);
		const json = JSON.parse(readFileSync(join(agentDir, "terrific.json"), "utf8")) as {
			mode: { default: string };
			modelProfile: {
				startup: boolean;
				startupScope: string;
				profiles: Array<{ id: string }>;
			};
		};
		assert.equal(json.mode.default, "edit");
		assert.equal(json.modelProfile.startup, true);
		assert.equal(json.modelProfile.startupScope, "global");
		assert.equal(json.modelProfile.profiles[0]?.id, 1);
	});

	it("patches profiles and picker hotkey while preserving sibling sections", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-terrific-profiles-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({ fast: { enabled: true } }), "utf8");
		const profiles = [{
			id: "1",
			alias: "daily",
			label: "Daily",
			provider: "openai",
			model: "gpt-test",
			thinking: "high" as const,
			hotkey: "alt+1",
		}];

		const result = patchModelProfileSection({ profiles, openHotkey: "ctrl+alt+l" }, agentDir);
		assert.equal(result.ok, true);
		const json = JSON.parse(readFileSync(join(agentDir, "terrific.json"), "utf8"));
		assert.deepEqual(json.fast, { enabled: true });
		assert.deepEqual(json.modelProfile.profiles, profiles);
		assert.equal(json.modelProfile.openHotkey, "ctrl+alt+l");
	});

	it("refuses to write while another process owns the config lock", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-terrific-lock-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({ fast: { enabled: true } }), "utf8");
		writeFileSync(`${path}.lock`, "owned", "utf8");

		const result = patchModelProfileSection({ startup: true }, agentDir);
		assert.equal(result.ok, false);
		assert.match(result.error, /lock/i);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { fast: { enabled: true } });
	});

	it("reclaims a lock left by a dead writer", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-terrific-stale-lock-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({ fast: { enabled: true } }), "utf8");
		writeFileSync(`${path}.lock`, JSON.stringify({
			pid: 999_999_999,
			createdAt: Date.now() - 60_000,
			token: "dead-writer",
		}), "utf8");

		const result = patchModelProfileSection({ startup: true }, agentDir);
		assert.equal(result.ok, true);
		assert.equal(existsSync(`${path}.lock`), false);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).modelProfile.startup, true);
	});

	it("refuses to overwrite malformed terrific.json", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-terrific-corrupt-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, "{ bad", "utf8");

		const result = patchModelProfileSection({ startup: true }, agentDir);
		assert.equal(result.ok, false);
		assert.equal(readFileSync(path, "utf8"), "{ bad");
	});
});
