import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	nextProfileId,
	runProfileConfigurator,
	type ProfileConfiguratorUi,
} from "../lib/configure.ts";
import type { ModelProfile, ThinkingLevel } from "../lib/types.ts";

class ScriptedUi implements ProfileConfiguratorUi {
	readonly dialogs: Array<{ title: string; options: string[] }> = [];
	readonly notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
	private readonly choices: string[];
	private readonly inputs: string[];
	private readonly models: string[];
	private readonly confirmations: boolean[];

	constructor(options: {
		choices: string[];
		inputs?: string[];
		models?: string[];
		confirmations?: boolean[];
	}) {
		this.choices = [...options.choices];
		this.inputs = [...(options.inputs ?? [])];
		this.models = [...(options.models ?? [])];
		this.confirmations = [...(options.confirmations ?? [])];
	}

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.dialogs.push({ title, options: [...options] });
		const prefix = this.choices.shift();
		if (prefix === undefined) return undefined;
		const choice = options.find((option) => option === prefix || option.startsWith(prefix));
		assert.ok(choice, `No option starts with ${JSON.stringify(prefix)} in ${JSON.stringify(options)}`);
		return choice;
	}

	async input(): Promise<string | undefined> {
		return this.inputs.shift();
	}

	async confirm(): Promise<boolean> {
		return this.confirmations.shift() ?? false;
	}

	async pickModel(): Promise<string | undefined> {
		return this.models.shift();
	}

	notify(message: string, level?: "info" | "warning" | "error"): void {
		this.notifications.push({ message, level });
	}
}

function config(agentDir: string): any {
	return JSON.parse(readFileSync(join(agentDir, "terrific.json"), "utf8"));
}

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
	return {
		id: "1",
		alias: "default",
		label: "Default",
		provider: "openai",
		model: "gpt-test",
		thinking: "medium",
		hotkey: "alt+1",
		...overrides,
	};
}

describe("model profile configurator", () => {
	it("allocates the next numeric profile id", () => {
		assert.equal(nextProfileId([]), "1");
		assert.equal(nextProfileId([profile(), profile({ id: "3", alias: "three" })]), "4");
	});

	it("adds the current session as a persisted profile", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-configure-add-"));
		const ui = new ScriptedUi({
			choices: ["Add current session", "Done"],
			inputs: ["daily", "Daily", ""],
		});

		await runProfileConfigurator({
			agentDir,
			currentModel: { provider: "openai", id: "gpt-current" },
			currentThinking: "high",
			modelRefs: ["openai/gpt-current"],
			quickApply: async () => {},
			ui,
		});

		assert.deepEqual(config(agentDir).modelProfile.profiles, [{
			id: "1",
			alias: "daily",
			label: "Daily",
			provider: "openai",
			model: "gpt-current",
			thinking: "high",
			hotkey: "alt+1",
		}]);
	});

	it("reads the live session after quick apply before adding a profile", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-configure-live-"));
		let current: { model: { provider: string; id: string }; thinking: ThinkingLevel } = {
			model: { provider: "openai", id: "old" },
			thinking: "low",
		};
		const ui = new ScriptedUi({
			choices: ["Quick apply", "Add current session", "Done"],
			inputs: ["live", "Live", ""],
		});

		await runProfileConfigurator({
			agentDir,
			currentThinking: "low",
			getCurrentSession: () => current,
			modelRefs: [],
			quickApply: async () => {
				current = { model: { provider: "anthropic", id: "claude-live" }, thinking: "high" };
			},
			ui,
		});

		const saved = config(agentDir).modelProfile.profiles[0];
		assert.equal(`${saved.provider}/${saved.model}`, "anthropic/claude-live");
		assert.equal(saved.thinking, "high");
	});

	it("edits label, alias, model, and hotkey", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-configure-fields-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			modelProfile: { profiles: [profile()] },
		}), "utf8");
		const ui = new ScriptedUi({
			choices: [
				"Manage profiles",
				"1 · default",
				"Label",
				"Alias",
				"Model",
				"Hotkey",
				"Back",
				"Back",
				"Done",
			],
			inputs: ["Work", "work", "ctrl+alt+9"],
			models: ["anthropic/claude-test"],
		});

		await runProfileConfigurator({
			agentDir,
			currentThinking: "medium",
			modelRefs: ["anthropic/claude-test"],
			quickApply: async () => {},
			ui,
		});

		assert.deepEqual(config(agentDir).modelProfile.profiles[0], {
			id: "1",
			alias: "work",
			label: "Work",
			provider: "anthropic",
			model: "claude-test",
			thinking: "medium",
			hotkey: "ctrl+alt+9",
		});
	});

	it("edits thinking and requires confirmation before delete", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-configure-edit-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			modelProfile: { profiles: [profile()] },
		}), "utf8");
		const editUi = new ScriptedUi({
			choices: ["Manage profiles", "1 · default", "Thinking", "high", "Back", "Back", "Done"],
		});

		await runProfileConfigurator({
			agentDir,
			currentThinking: "medium",
			modelRefs: ["openai/gpt-test"],
			quickApply: async () => {},
			ui: editUi,
		});
		assert.equal(config(agentDir).modelProfile.profiles[0].thinking, "high");

		const cancelUi = new ScriptedUi({
			choices: ["Manage profiles", "1 · default", "Delete profile", "Back", "Back", "Done"],
			confirmations: [false],
		});
		await runProfileConfigurator({
			agentDir,
			currentThinking: "medium",
			modelRefs: [],
			quickApply: async () => {},
			ui: cancelUi,
		});
		assert.equal(config(agentDir).modelProfile.profiles.length, 1);

		const deleteUi = new ScriptedUi({
			choices: ["Manage profiles", "1 · default", "Delete profile", "Done"],
			confirmations: [true],
		});
		await runProfileConfigurator({
			agentDir,
			currentThinking: "medium",
			modelRefs: [],
			quickApply: async () => {},
			ui: deleteUi,
		});
		assert.deepEqual(config(agentDir).modelProfile.profiles, []);
	});

	it("edits startup defaults and the picker hotkey", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-configure-startup-"));
		const ui = new ScriptedUi({
			choices: [
				"Startup & shortcuts",
				"Startup picker",
				"On",
				"Startup scope",
				"global",
				"Open picker hotkey",
				"Back",
				"Done",
			],
			inputs: ["ctrl+alt+p"],
		});

		await runProfileConfigurator({
			agentDir,
			currentThinking: "medium",
			modelRefs: [],
			quickApply: async () => {},
			ui,
		});

		const saved = config(agentDir).modelProfile;
		assert.equal(saved.startup, true);
		assert.equal(saved.startupScope, "global");
		assert.equal(saved.openHotkey, "ctrl+alt+p");
		assert.ok(ui.notifications.some(({ message }) => /reload/i.test(message)));
	});

	it("creates a project override from an effective global profile", async () => {
		const root = mkdtempSync(join(tmpdir(), "mp-configure-project-"));
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const projectConfigDir = join(projectDir, ".pi");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectConfigDir, { recursive: true });
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			modelProfile: { profiles: [profile()] },
		}), "utf8");
		const ui = new ScriptedUi({
			choices: ["Project overrides", "1 · default", "Model", "Back", "Back", "Done"],
			models: ["anthropic/claude-project"],
		});

		await runProfileConfigurator({
			agentDir,
			projectDir: projectConfigDir,
			cwd: projectDir,
			currentThinking: "medium",
			modelRefs: ["anthropic/claude-project"],
			quickApply: async () => {},
			ui,
		});

		assert.equal(config(agentDir).modelProfile.profiles[0].model, "gpt-test");
		const saved = config(projectConfigDir).modelProfile.profiles[0];
		assert.deepEqual(saved, {
			id: "1",
			provider: "anthropic",
			model: "claude-project",
		});
	});

	it("shows current, source, scope, and effective startup values", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-configure-show-"));
		const ui = new ScriptedUi({ choices: ["Show effective config", "Done"] });
		await runProfileConfigurator({
			agentDir,
			currentModel: { provider: "openai", id: "gpt-current" },
			currentThinking: "high",
			modelRefs: [],
			quickApply: async () => {},
			getEffectiveConfig: () => ({
				config: { startup: true, startupScope: "session", openHotkey: "ctrl+alt+l", profiles: [profile()] },
				source: "global → project",
			}),
			ui,
		});

		const message = ui.notifications.at(-1)?.message ?? "";
		assert.match(message, /Current session: openai\/gpt-current · high/);
		assert.match(message, /Config source: global → project/);
		assert.match(message, /Manager write scope: global profiles\/startup; project overrides when selected/);
		assert.match(message, /Startup: on · preferred scope session/);
	});

	it("keeps quick apply as the first-class action", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-configure-apply-"));
		let calls = 0;
		const ui = new ScriptedUi({ choices: ["Quick apply", "Done"] });
		await runProfileConfigurator({
			agentDir,
			currentThinking: "medium",
			modelRefs: [],
			quickApply: async () => { calls += 1; },
			ui,
		});
		assert.equal(calls, 1);
	});
});
