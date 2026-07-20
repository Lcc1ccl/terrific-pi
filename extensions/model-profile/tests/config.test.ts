import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	defaultHotkeyForId,
	findProfile,
	findProfileByAlias,
	findProfileByHotkey,
	findProfileById,
	loadConfig,
	loadConfigWithSources,
	mergeConfig,
	parseProfile,
	resolveConfigPaths,
} from "../lib/config.ts";

describe("parseProfile", () => {
	it("accepts numeric id and alias with default hotkey", () => {
		const { profile, warning } = parseProfile(
			{
				id: 1,
				alias: "default",
				provider: "openai",
				model: "gpt-5.6-sol",
				thinking: "medium",
			},
			0,
		);
		assert.equal(warning, undefined);
		assert.deepEqual(profile, {
			id: "1",
			alias: "default",
			label: "default",
			provider: "openai",
			model: "gpt-5.6-sol",
			thinking: "medium",
			hotkey: "alt+1",
		});
	});

	it("defaults alias of id 1 to default", () => {
		const { profile } = parseProfile(
			{ id: "1", provider: "openai", model: "m", thinking: "low" },
			0,
		);
		assert.equal(profile?.alias, "default");
		assert.equal(profile?.hotkey, "alt+1");
	});

	it("rejects non-numeric ids", () => {
		const { profile, warning } = parseProfile(
			{ id: "daily", provider: "p", model: "m", thinking: "low" },
			0,
		);
		assert.equal(profile, undefined);
		assert.match(String(warning), /positive integer/);
	});
});

describe("mergeConfig", () => {
	it("dedupes ids, aliases, and hotkeys; sorts by id", () => {
		const { config, warnings } = mergeConfig({
			profiles: [
				{ id: 2, alias: "b", provider: "p", model: "m2", thinking: "high" },
				{ id: 1, alias: "a", provider: "p", model: "m1", thinking: "low" },
				{ id: 1, alias: "dup", provider: "p", model: "m3", thinking: "medium" },
				{ id: 3, alias: "a", provider: "p", model: "m4", thinking: "off" },
			],
		});
		assert.deepEqual(
			config.profiles.map((p) => p.id),
			["1", "2"],
		);
		assert.equal(config.profiles[0]?.hotkey, "alt+1");
		assert.equal(config.profiles[1]?.hotkey, "alt+2");
		assert.ok(warnings.some((w) => /duplicate id/i.test(w)));
		assert.ok(warnings.some((w) => /duplicate alias/i.test(w)));
	});
});

describe("resolveConfigPaths / loadConfig", () => {
	it("skips project path when untrusted", () => {
		assert.deepEqual(resolveConfigPaths("/ws", "/agent", false, ".pi"), ["/agent/terrific.json"]);
	});

	it("loads global and overrides by id from trusted project", () => {
		const root = mkdtempSync(join(tmpdir(), "model-profile-"));
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const projectPi = join(projectDir, ".pi");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectPi, { recursive: true });

		writeFileSync(
			join(agentDir, "terrific.json"),
			JSON.stringify({
				modelProfile: {
					startup: false,
					profiles: [
						{ id: 1, alias: "default", provider: "grok", model: "old", thinking: "high" },
						{ id: 2, alias: "fast", provider: "openai", model: "mini", thinking: "low" },
					],
				},
			}),
		);
		writeFileSync(
			join(projectPi, "terrific.json"),
			JSON.stringify({
				modelProfile: {
					startup: true,
					profiles: [{ id: 1, alias: "default", provider: "grok", model: "new", thinking: "medium" }],
				},
			}),
		);

		const { config, warnings } = loadConfig(projectDir, agentDir, true, ".pi");
		assert.equal(warnings.length, 0);
		assert.equal(config.startup, true);
		assert.equal(config.profiles.length, 2);
		const daily = findProfileById(config.profiles, "1");
		assert.equal(daily?.model, "new");
		assert.equal(daily?.thinking, "medium");
		assert.ok(findProfileByAlias(config.profiles, "fast"));
		const sourced = loadConfigWithSources(projectDir, agentDir, true, ".pi");
		assert.equal(sourced.profileSources["1"], "project");
		assert.equal(sourced.profileSources["2"], "global");
	});

	it("keeps global startup options when a project only overrides profiles", () => {
		const root = mkdtempSync(join(tmpdir(), "model-profile-inherit-"));
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const projectPi = join(projectDir, ".pi");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectPi, { recursive: true });

		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			modelProfile: {
				startup: true,
				startupScope: "global",
				openHotkey: "ctrl+alt+p",
				profiles: [{ id: 1, provider: "openai", model: "global", thinking: "medium" }],
			},
		}), "utf8");
		writeFileSync(join(projectPi, "terrific.json"), JSON.stringify({
			modelProfile: {
				profiles: [{ id: 1, provider: "anthropic", model: "project", thinking: "high" }],
			},
		}), "utf8");

		const { config } = loadConfig(projectDir, agentDir, true, ".pi");
		assert.equal(config.startup, true);
		assert.equal(config.startupScope, "global");
		assert.equal(config.openHotkey, "ctrl+alt+p");
		assert.equal(config.profiles[0]?.model, "project");
	});

	it("survives corrupt JSON", () => {
		const root = mkdtempSync(join(tmpdir(), "model-profile-bad-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "terrific.json"), "{not-json");
		const { config, warnings } = loadConfig(root, agentDir, false, ".pi");
		assert.equal(config.profiles.length, 0);
		assert.ok(warnings.length > 0);
	});
});

describe("find helpers", () => {
	const profiles = [
		{
			id: "1",
			alias: "default",
			label: "default",
			provider: "openai",
			model: "sol",
			thinking: "medium" as const,
			hotkey: "alt+1",
		},
		{
			id: "2",
			alias: "lunamax",
			label: "lunamax",
			provider: "openai",
			model: "luna",
			thinking: "max" as const,
			hotkey: "alt+2",
		},
	];

	it("finds by id, alias, and hotkey", () => {
		assert.equal(findProfile(profiles, "1")?.alias, "default");
		assert.equal(findProfile(profiles, "default")?.id, "1");
		assert.equal(findProfile(profiles, "LUNAMAX")?.id, "2");
		assert.equal(findProfileByHotkey(profiles, "Alt+2")?.alias, "lunamax");
	});

	it("defaultHotkeyForId maps 1–9 only", () => {
		assert.equal(defaultHotkeyForId("1"), "alt+1");
		assert.equal(defaultHotkeyForId("9"), "alt+9");
		assert.equal(defaultHotkeyForId("10"), undefined);
	});
});
