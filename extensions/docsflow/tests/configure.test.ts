import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { runDocsflowSettingsConfigurator, type DocsflowSettingsUi } from "../lib/configure.ts";

class ScriptedUi implements DocsflowSettingsUi {
	readonly notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
	private readonly choices: string[];
	private readonly inputs: string[];

	constructor(choices: string[], inputs: string[] = []) {
		this.choices = [...choices];
		this.inputs = [...inputs];
	}

	async select(_title: string, options: string[]): Promise<string | undefined> {
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
		return true;
	}

	notify(message: string, level?: "info" | "warning" | "error"): void {
		this.notifications.push({ message, level });
	}
}

function readConfig(agentDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path.join(agentDir, "terrific.json"), "utf8")) as Record<string, unknown>;
}

describe("docsflow settings configurator", () => {
	test("edits output settings and a validated stage override", async () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-configure-"));
		const ui = new ScriptedUi(
			[
				"Output location",
				"Vault",
				"Config reminder",
				"Off",
				"Stage overrides",
				"research",
				"Model",
				"Set model",
				"Thinking",
				"high",
				"Timeout",
				"Set value",
				"Back",
				"Back",
				"Back",
			],
			["openai/gpt-test", "45000"],
		);

		await runDocsflowSettingsConfigurator({
			agentDir,
			modelRefs: ["openai/gpt-test"],
			ui,
		});

		const docsflow = readConfig(agentDir).docsflow as Record<string, any>;
		assert.equal(docsflow.vaultEnabled, true);
		assert.equal(docsflow.configReminder, false);
		assert.deepEqual(docsflow.stageOverrides.research, {
			model: "openai/gpt-test",
			thinking: "high",
			timeoutMs: 45_000,
		});
	});

	test("rejects an unavailable stage model before writing it", async () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-configure-invalid-"));
		const ui = new ScriptedUi(
			["Stage overrides", "research", "Model", "Set model", "Back", "Back", "Back"],
			["openai/missing"],
		);

		await runDocsflowSettingsConfigurator({ agentDir, modelRefs: ["openai/gpt-test"], ui });

		assert.ok(ui.notifications.some(({ level, message }) => level === "warning" && /unavailable/i.test(message)));
		assert.equal(existsSync(path.join(agentDir, "terrific.json")), false);
	});

	test("rejects thinking unavailable on the effective stage model", async () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-configure-thinking-"));
		const ui = new ScriptedUi(["Stage overrides", "research", "Thinking", "high", "Back", "Back", "Back"]);

		await runDocsflowSettingsConfigurator({
			agentDir,
			modelRefs: ["openai/plain"],
			modelCapabilities: [{ ref: "openai/plain", reasoning: false }],
			stageDefaults: { research: { model: "openai/plain" } },
			ui,
		});

		assert.ok(ui.notifications.some(({ level, message }) => level === "warning" && /does not support/i.test(message)));
		assert.equal(existsSync(path.join(agentDir, "terrific.json")), false);
	});

	test("rejects resetting thinking when the profile fallback conflicts with an overridden model", async () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-configure-reset-thinking-"));
		writeFileSync(path.join(agentDir, "terrific.json"), JSON.stringify({
			docsflow: { stageOverrides: { research: { model: "openai/plain", thinking: "off" } } },
		}), "utf8");
		const ui = new ScriptedUi(["Stage overrides", "research", "Thinking", "Reset override", "Back", "Back", "Back"]);

		await runDocsflowSettingsConfigurator({
			agentDir,
			modelRefs: ["openai/plain", "openai/reason"],
			modelCapabilities: [
				{ ref: "openai/plain", reasoning: false },
				{ ref: "openai/reason", reasoning: true },
			],
			stageDefaults: { research: { model: "openai/reason", thinking: "high" } },
			ui,
		});

		assert.deepEqual((readConfig(agentDir).docsflow as Record<string, any>).stageOverrides.research, {
			model: "openai/plain",
			thinking: "off",
		});
		assert.ok(ui.notifications.some(({ level, message }) => level === "warning" && /does not support/i.test(message)));
	});

	test("rejects resetting a model when its current thinking is unsupported by the profile fallback", async () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "docsflow-configure-reset-model-"));
		writeFileSync(path.join(agentDir, "terrific.json"), JSON.stringify({
			docsflow: { stageOverrides: { research: { model: "openai/reason", thinking: "high" } } },
		}), "utf8");
		const ui = new ScriptedUi(["Stage overrides", "research", "Model", "Reset override", "Back", "Back", "Back"]);

		await runDocsflowSettingsConfigurator({
			agentDir,
			modelRefs: ["openai/plain", "openai/reason"],
			modelCapabilities: [
				{ ref: "openai/plain", reasoning: false },
				{ ref: "openai/reason", reasoning: true },
			],
			stageDefaults: { research: { model: "openai/plain", thinking: "off" } },
			ui,
		});

		assert.deepEqual((readConfig(agentDir).docsflow as Record<string, any>).stageOverrides.research, {
			model: "openai/reason",
			thinking: "high",
		});
		assert.ok(ui.notifications.some(({ level, message }) => level === "warning" && /does not support/i.test(message)));
	});
});
