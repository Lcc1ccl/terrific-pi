import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	applyProfile,
	applyResultLevel,
	formatApplySuccess,
	type ApplyDeps,
} from "../lib/apply.ts";
import type { SettingsDefaults } from "../lib/settings-defaults.ts";
import type { ModelProfile } from "../lib/types.ts";

const profile: ModelProfile = {
	id: "1",
	alias: "default",
	label: "default",
	provider: "grok",
	model: "grok-4.5",
	thinking: "high",
};

function deps(overrides: Partial<ApplyDeps> & Pick<ApplyDeps, "getThinkingLevel">): ApplyDeps {
	return {
		findModel: (provider, modelId) => ({ provider, id: modelId }),
		setModel: async () => true,
		setThinkingLevel: () => {},
		snapshotSettingsFile: () => ({
			ok: true,
			path: "/settings.json",
			exists: true,
			content: "{}",
			mode: 0o600,
		}),
		restoreSettingsFile: () => ({ ok: true }),
		...overrides,
	};
}

describe("applyProfile", () => {
	it("session apply restores the exact settings snapshot after pi-like mutation", async () => {
		const original: SettingsDefaults = {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium",
		};
		const settings: SettingsDefaults = { ...original };

		const result = await applyProfile(
			profile,
			"session",
			deps({
				getThinkingLevel: () => "high",
				snapshotSettingsFile: () => ({
					ok: true,
					path: "/settings.json",
					exists: true,
					content: JSON.stringify(original),
					mode: 0o600,
				}),
				setModel: async (model) => {
					settings.defaultProvider = model.provider;
					settings.defaultModel = model.id;
					return true;
				},
				setThinkingLevel: (level) => {
					settings.defaultThinkingLevel = level;
				},
				restoreSettingsFile: (snapshot) => {
					if (!snapshot.exists) return { ok: false, error: "expected settings file" };
					Object.assign(settings, JSON.parse(snapshot.content) as SettingsDefaults);
					return { ok: true };
				},
			}),
		);

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.settingsRestored, true);
			assert.equal(applyResultLevel(result), "info");
			assert.match(formatApplySuccess(result), /Restored original settings/);
		}
		assert.deepEqual(settings, original);
	});

	it("does not switch models when the settings snapshot is unavailable", async () => {
		let setModelCalls = 0;
		const result = await applyProfile(profile, "session", deps({
			getThinkingLevel: () => "high",
			snapshotSettingsFile: () => ({ ok: false, path: "/settings.json", error: "permission denied" }),
			setModel: async () => {
				setModelCalls += 1;
				return true;
			},
		}));
		assert.equal(result.ok, false);
		assert.equal(setModelCalls, 0);
	});

	it("waits for Pi's queued thinking write before restoring settings", async () => {
		const original: SettingsDefaults = {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium",
		};
		let settings: SettingsDefaults = { ...original };
		let thinking: "medium" | "high" = "medium";

		const result = await applyProfile(profile, "session", deps({
			getThinkingLevel: () => thinking,
			snapshotSettingsFile: () => ({
				ok: true,
				path: "/settings.json",
				exists: true,
				content: JSON.stringify(original),
				mode: 0o600,
			}),
			setModel: async (model) => {
				settings.defaultProvider = model.provider;
				settings.defaultModel = model.id;
				return true;
			},
			setThinkingLevel: (level) => {
				thinking = level as "medium" | "high";
				queueMicrotask(() => {
					settings.defaultThinkingLevel = level;
				});
			},
			restoreSettingsFile: (snapshot) => {
				if (!snapshot.exists) return { ok: false, error: "expected settings file" };
				settings = JSON.parse(snapshot.content) as SettingsDefaults;
				return { ok: true };
			},
		}));

		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.settingsRestored, true);
		assert.deepEqual(settings, original);
	});

	it("reports thinking clamp", async () => {
		const result = await applyProfile(
			profile,
			"session",
			deps({
				getThinkingLevel: () => "medium",
			}),
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.thinkingClamped, true);
			assert.match(formatApplySuccess(result), /Requested thinking/);
		}
	});

	it("fails on unknown model", async () => {
		const result = await applyProfile(
			profile,
			"session",
			deps({
				findModel: () => undefined,
				getThinkingLevel: () => "off",
			}),
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.kind, "unknown-model");
	});

	it("fails when setModel refuses", async () => {
		const result = await applyProfile(
			profile,
			"session",
			deps({
				setModel: async () => false,
				getThinkingLevel: () => "off",
			}),
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.kind, "set-model-refused");
	});

	it("writes settings defaults on global scope", async () => {
		let written: unknown;
		const result = await applyProfile(
			profile,
			"global",
			deps({
				getThinkingLevel: () => "high",
				writeSettingsDefaults: (defaults) => {
					written = defaults;
					return { ok: true };
				},
			}),
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.scope, "global");
			assert.equal(result.settingsWritten, true);
			assert.match(formatApplySuccess(result), /Updated settings\.json/);
		}
		assert.deepEqual(written, {
			defaultProvider: "grok",
			defaultModel: "grok-4.5",
			defaultThinkingLevel: "high",
		});
	});

	it("keeps session change when global settings write fails", async () => {
		const result = await applyProfile(
			profile,
			"global",
			deps({
				getThinkingLevel: () => "high",
				writeSettingsDefaults: () => ({ ok: false, error: "disk full" }),
			}),
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.settingsWritten, false);
			assert.equal(applyResultLevel(result), "warning");
			assert.match(formatApplySuccess(result), /settings write failed: disk full/);
		}
	});
});
