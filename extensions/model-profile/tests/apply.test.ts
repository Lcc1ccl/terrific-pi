import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	applyProfile,
	applyResultLevel,
	formatApplySuccess,
	type ApplyDeps,
} from "../lib/apply.ts";
import type { SettingsDefaults, SettingsDefaultsSnapshot } from "../lib/settings-defaults.ts";
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
		...overrides,
	};
}

describe("applyProfile", () => {
	it("session apply restores prior defaults after pi-like setModel mutation", async () => {
		const settings: SettingsDefaults = {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium",
		};
		const snapshot: SettingsDefaultsSnapshot = { ...settings, incomplete: false };

		const result = await applyProfile(
			profile,
			"session",
			deps({
				getThinkingLevel: () => "high",
				readSettingsDefaults: () => ({ ...snapshot }),
				setModel: async (m) => {
					// Simulate pi.setModel writing globals
					settings.defaultProvider = m.provider;
					settings.defaultModel = m.id;
					return true;
				},
				setThinkingLevel: (level) => {
					settings.defaultThinkingLevel = level;
				},
				writeSettingsDefaults: (defaults) => {
					settings.defaultProvider = defaults.defaultProvider;
					settings.defaultModel = defaults.defaultModel;
					settings.defaultThinkingLevel = defaults.defaultThinkingLevel;
					return { ok: true };
				},
			}),
		);

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.settingsRestored, true);
			assert.equal(applyResultLevel(result), "info");
			assert.match(formatApplySuccess(result), /Restored previous settings/);
		}
		assert.deepEqual(settings, {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium",
		});
	});

	it("warns when snapshot missing", async () => {
		const result = await applyProfile(
			profile,
			"session",
			deps({
				getThinkingLevel: () => "high",
				readSettingsDefaults: () => undefined,
			}),
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.settingsRestored, false);
			assert.equal(applyResultLevel(result), "warning");
			assert.match(String(result.settingsError), /could not snapshot/i);
		}
	});

	it("restores incomplete snapshot with thinking fallback", async () => {
		let written: SettingsDefaults | undefined;
		const result = await applyProfile(
			profile,
			"session",
			deps({
				getThinkingLevel: () => {
					// before switch returns medium; after setThinking returns high
					return written ? "high" : "medium";
				},
				readSettingsDefaults: () => ({
					defaultProvider: "openai",
					defaultModel: "gpt-5.6-sol",
					incomplete: true,
				}),
				writeSettingsDefaults: (defaults) => {
					written = defaults;
					return { ok: true };
				},
			}),
		);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.settingsRestored, true);
			assert.equal(applyResultLevel(result), "warning");
			assert.match(String(result.settingsError), /incomplete/i);
		}
		assert.deepEqual(written, {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium",
		});
	});

	it("reports thinking clamp", async () => {
		const result = await applyProfile(
			profile,
			"session",
			deps({
				getThinkingLevel: () => "medium",
				readSettingsDefaults: () => ({
					defaultProvider: "openai",
					defaultModel: "sol",
					defaultThinkingLevel: "medium",
					incomplete: false,
				}),
				writeSettingsDefaults: () => ({ ok: true }),
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
				readSettingsDefaults: () => ({
					defaultProvider: "openai",
					defaultModel: "sol",
					defaultThinkingLevel: "medium",
					incomplete: false,
				}),
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
