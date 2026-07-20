import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ApplyDeps } from "../lib/apply.ts";
import { profileLabel } from "../lib/config.ts";
import {
	formatKeepCurrentLabel,
	profilesForStartupList,
	runStartupPicker,
} from "../lib/startup.ts";
import type { ModelProfileConfig } from "../lib/types.ts";

const config: ModelProfileConfig = {
	startup: true,
	startupScope: "session",
	profiles: [
		{
			id: "1",
			alias: "default",
			label: "default",
			provider: "openai",
			model: "gpt-5.6-sol",
			thinking: "medium",
			hotkey: "alt+1",
		},
		{
			id: "2",
			alias: "lunamax",
			label: "lunamax",
			provider: "openai",
			model: "gpt-5.6-luna",
			thinking: "max",
			hotkey: "alt+2",
		},
	],
};

function deps(overrides: Partial<ApplyDeps> = {}): ApplyDeps {
	return {
		findModel: (provider, modelId) => ({ provider, id: modelId }),
		setModel: async () => true,
		setThinkingLevel: () => {},
		getThinkingLevel: () => "high",
		writeSettingsDefaults: () => ({ ok: true }),
		...overrides,
	};
}

const current = { provider: "openai", id: "gpt-5.6-sol" };
const keepLabel = formatKeepCurrentLabel(current, "medium");

describe("formatKeepCurrentLabel", () => {
	it("names the activated session model", () => {
		assert.equal(
			formatKeepCurrentLabel({ provider: "openai", id: "gpt-5.6-sol" }, "max"),
			"Keep current session · openai/gpt-5.6-sol · max",
		);
	});
});

describe("profilesForStartupList", () => {
	it("drops the profile that matches current session (default)", () => {
		const listed = profilesForStartupList(config.profiles, current, "medium");
		assert.deepEqual(
			listed.map((p) => p.id),
			["2"],
		);
	});
});

describe("runStartupPicker", () => {
	it("skips resume/fork/reload", async () => {
		for (const reason of ["resume", "fork", "reload"] as const) {
			const result = await runStartupPicker({
				reason,
				hasUI: true,
				config,
				deps: deps(),
				currentModel: current,
				currentThinking: "medium",
				getAvailable: () => [],
				ui: { select: async () => undefined },
			});
			assert.deepEqual(result, { action: "skipped", reason: `reason:${reason}` });
		}
	});

	it("runs for startup and new", async () => {
		for (const reason of ["startup", "new"] as const) {
			const result = await runStartupPicker({
				reason,
				hasUI: true,
				config,
				deps: deps(),
				currentModel: current,
				currentThinking: "medium",
				getAvailable: () => [],
				ui: { select: async () => keepLabel },
			});
			assert.deepEqual(result, { action: "cancelled", reason: "keep-current" });
		}
	});

	it("skips when startup disabled", async () => {
		const result = await runStartupPicker({
			reason: "new",
			hasUI: true,
			config: { ...config, startup: false },
			deps: deps(),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [],
			ui: { select: async () => undefined },
		});
		assert.deepEqual(result, { action: "skipped", reason: "startup-disabled" });
	});

	it("applies a non-current profile", async () => {
		const answers = [profileLabel(config.profiles[1]!), "session — this chat only"];
		const result = await runStartupPicker({
			reason: "new",
			hasUI: true,
			config,
			deps: deps(),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [],
			ui: { select: async () => answers.shift() },
		});
		assert.equal(result.action, "applied");
		if (result.action === "applied" && result.source === "profile") {
			assert.equal(result.profile.id, "2");
		}
	});

	it("lists keep first, excludes matching default, browse last", async () => {
		let seen: string[] | undefined;
		await runStartupPicker({
			reason: "startup",
			hasUI: true,
			config,
			deps: deps(),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [{ provider: "openai", id: "x" }],
			ui: {
				select: async (_title, options) => {
					seen = options;
					return keepLabel;
				},
			},
		});
		assert.ok(seen);
		assert.equal(seen![0], keepLabel);
		assert.equal(seen![seen!.length - 1], "Browse all models…");
		assert.ok(!seen!.some((line) => line.includes("default —")));
		assert.ok(seen!.some((line) => line.includes("lunamax")));
	});

	it("browse all still works as last option", async () => {
		const answers = [
			"Browse all models…",
			"openai",
			"openai/gpt-5.6-luna",
			"session — this chat only",
		];
		const settings = {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium" as const,
		};
		const result = await runStartupPicker({
			reason: "new",
			hasUI: true,
			config,
			deps: deps({
				getThinkingLevel: () => "max",
				readSettingsDefaults: () => ({ ...settings, incomplete: false }),
				setModel: async (m) => {
					settings.defaultProvider = m.provider;
					settings.defaultModel = m.id;
					return true;
				},
				writeSettingsDefaults: (defaults) => {
					Object.assign(settings, defaults);
					return { ok: true };
				},
			}),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [
				{ provider: "openai", id: "gpt-5.6-luna" },
				{ provider: "openai", id: "gpt-5.6-sol" },
			],
			ui: { select: async () => answers.shift() },
		});
		assert.equal(result.action, "applied");
		if (result.action === "applied" && result.source === "manual") {
			assert.equal(result.model.id, "gpt-5.6-luna");
			assert.equal(result.settingsRestored, true);
		}
		assert.deepEqual(settings, {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium",
		});
	});
});
