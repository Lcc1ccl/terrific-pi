import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { getKeybindings } from "@earendil-works/pi-tui";

import {
	availableTextModelRefs,
	pickAvailableModel,
	parseRouteInteger,
	redactConfigForDisplay,
	resolveCurrentModelRef,
	runAuxiliaryConfigurator,
	type AuxiliaryConfiguratorUi,
} from "../lib/configure.ts";

class ScriptedUi implements AuxiliaryConfiguratorUi {
	readonly notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
	readonly dialogs: Array<{ title: string; options: string[] }> = [];
	private readonly choices: string[];
	private readonly inputs: string[];
	private readonly models: string[];
	private readonly confirmations: boolean[];

	constructor(
		choices: string[],
		inputs: string[] = [],
		models: string[] = [],
		confirmations: boolean[] = [],
	) {
		this.choices = choices;
		this.inputs = inputs;
		this.models = models;
		this.confirmations = confirmations;
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

function readConfig(agentDir: string): Record<string, any> {
	return JSON.parse(readFileSync(join(agentDir, "terrific.json"), "utf8")) as Record<string, any>;
}

describe("auxiliary configurator", () => {
	test("disables the runtime and routes one task through the saved main model", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-toggle-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			docsflow: { vaultEnabled: false },
			auxiliary: {
				enabled: true,
				tasks: {
					compression: {
						model: "openai/saved-auxiliary",
						fallbackModels: ["openai/saved-fallback"],
					},
				},
			},
		}), "utf8");
		const ui = new ScriptedUi([
			"Runtime",
			"Disabled",
			"compression",
			"Use auxiliary model",
			"Off",
			"Back",
			"Done",
		]);

		await runAuxiliaryConfigurator({
			agentDir,
			currentModel: "openai/main",
			modelRefs: ["openai/saved-auxiliary", "openai/saved-fallback"],
			ui,
		});

		const saved = readConfig(agentDir);
		assert.equal(saved.auxiliary.enabled, false);
		assert.equal(saved.auxiliary.tasks.compression.useAuxiliary, false);
		assert.equal(saved.auxiliary.tasks.compression.model, "openai/saved-auxiliary");
		assert.deepEqual(saved.auxiliary.tasks.compression.fallbackModels, ["openai/saved-fallback"]);
		assert.deepEqual(saved.docsflow, { vaultEnabled: false });
	});

	test("edits a task model, thinking, timeout, and fallback", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-route-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			auxiliary: { tasks: { text_summary: { fallbackModels: [] } } },
		}), "utf8");
		const ui = new ScriptedUi(
			[
				"text_summary",
				"Primary model",
				"Choose model",
				"Thinking",
				"high",
				"Timeout",
				"Set value",
				"Fallback models",
				"Add model",
				"Back",
				"Back",
				"Done",
			],
			["45000"],
			["openai/new-summary", "openai/summary-fallback"],
		);

		await runAuxiliaryConfigurator({
			agentDir,
			currentModel: "openai/main",
			modelRefs: ["openai/new-summary", "openai/summary-fallback"],
			ui,
		});

		assert.deepEqual(readConfig(agentDir).auxiliary.tasks.text_summary, {
			fallbackModels: ["openai/summary-fallback"],
			model: "openai/new-summary",
			thinking: "high",
			timeoutMs: 45_000,
		});
	});

	test("resets only known route fields and preserves future fields", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-reset-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			auxiliary: {
				default: { model: "openai/default", timeoutMs: 45_000, futureDefault: "keep" },
				tasks: {
					compression: {
						useAuxiliary: false,
						model: "openai/compression",
						fallbackModels: ["openai/fallback"],
						futureTask: "keep",
					},
					custom_task: { model: "openai/custom" },
				},
			},
		}), "utf8");
		const ui = new ScriptedUi([
			"Default route",
			"Reset default route",
			"compression",
			"Reset task overrides",
			"Done",
		], [], [], [true, true]);

		await runAuxiliaryConfigurator({ agentDir, modelRefs: [], ui });

		const auxiliary = readConfig(agentDir).auxiliary;
		assert.deepEqual(auxiliary.default, { futureDefault: "keep" });
		assert.deepEqual(auxiliary.tasks.compression, { futureTask: "keep" });
		assert.deepEqual(auxiliary.tasks.custom_task, { model: "openai/custom" });
	});

	test("resets one numeric override without changing the rest of the task route", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-number-reset-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			auxiliary: { tasks: { text_summary: { model: "openai/summary", timeoutMs: 45_000 } } },
		}), "utf8");
		const ui = new ScriptedUi([
			"text_summary",
			"Timeout",
			"Reset override",
			"Back",
			"Done",
		]);

		await runAuxiliaryConfigurator({ agentDir, modelRefs: ["openai/summary"], ui });

		assert.deepEqual(readConfig(agentDir).auxiliary.tasks.text_summary, { model: "openai/summary" });
	});

	test("hides reset actions when model and thinking inherit defaults", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-inherited-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			auxiliary: { tasks: { text_summary: { fallbackModels: [] } } },
		}), "utf8");
		const ui = new ScriptedUi([
			"text_summary",
			"Primary model",
			"Back",
			"Thinking",
			"Back",
			"Back",
			"Done",
		]);

		await runAuxiliaryConfigurator({ agentDir, modelRefs: [], ui });

		for (const title of ["text_summary primary model", "text_summary thinking"]) {
			const dialog = ui.dialogs.find((item) => item.title === title);
			assert.ok(dialog, title);
			assert.equal(dialog.options.some((option) => option.startsWith("Reset override")), false);
		}
	});

	test("hides route reset actions when no route override exists", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-route-inherited-"));
		const ui = new ScriptedUi([
			"Default route",
			"Back",
			"text_summary",
			"Back",
			"Done",
		]);

		await runAuxiliaryConfigurator({ agentDir, modelRefs: [], ui });

		for (const title of ["Default route", "text_summary"]) {
			const dialog = ui.dialogs.find((item) => item.title === title);
			assert.ok(dialog, title);
			assert.equal(dialog.options.some((option) => option.startsWith("Reset ")), false);
		}
	});

	test("shows only route fields consumed by BTW and Web Research", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-capabilities-"));
		const ui = new ScriptedUi([
			"btw",
			"Back",
			"web_research",
			"Back",
			"Done",
		]);

		await runAuxiliaryConfigurator({ agentDir, modelRefs: [], ui });

		const btw = ui.dialogs.find((item) => item.title === "btw");
		assert.ok(btw);
		assert.ok(btw.options.some((option) => option.startsWith("Max output tokens")));
		assert.equal(btw.options.some((option) => option.startsWith("Retries")), false);

		const research = ui.dialogs.find((item) => item.title === "web_research");
		assert.ok(research);
		assert.equal(research.options.some((option) => option.startsWith("Max output tokens")), false);
		assert.equal(research.options.some((option) => option.startsWith("Retries")), false);
	});

	test("edits Git finalize policy without replacing sibling configuration", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-git-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			fast: { enabled: true },
			auxiliary: { git: { confirm: true, allowHeadless: false, allowPush: true, futurePolicy: "keep" } },
		}), "utf8");
		const ui = new ScriptedUi([
			"Git finalize policy",
			"Confirm before commit",
			"Off",
			"Allow headless",
			"On",
			"Allow push",
			"Off",
			"Back",
			"Done",
		]);

		await runAuxiliaryConfigurator({ agentDir, modelRefs: [], ui });

		const saved = readConfig(agentDir);
		assert.deepEqual(saved.fast, { enabled: true });
		assert.deepEqual(saved.auxiliary.git, {
			confirm: false,
			allowHeadless: true,
			allowPush: false,
			futurePolicy: "keep",
		});
	});

	test("confirms Git policy reset and preserves future policy keys", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-git-reset-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			auxiliary: { git: { confirm: false, allowHeadless: true, allowPush: false, futurePolicy: "keep" } },
		}), "utf8");
		const ui = new ScriptedUi(["Git finalize policy", "Reset Git policy", "Back", "Done"], [], [], [true]);

		await runAuxiliaryConfigurator({ agentDir, modelRefs: [], ui });

		assert.deepEqual(readConfig(agentDir).auxiliary.git, { futurePolicy: "keep" });
	});

	test("rejects an explicit fallback that resolves to the current primary model", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-duplicate-current-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			auxiliary: { tasks: { text_summary: { model: "current", fallbackModels: [] } } },
		}), "utf8");
		const ui = new ScriptedUi([
			"text_summary",
			"Fallback models",
			"Add model",
			"Back",
			"Back",
			"Done",
		], [], ["openai/main"]);

		await runAuxiliaryConfigurator({
			agentDir,
			currentModel: "openai/main",
			modelRefs: ["openai/main"],
			ui,
		});

		assert.deepEqual(readConfig(agentDir).auxiliary.tasks.text_summary.fallbackModels, []);
		assert.ok(ui.notifications.some(({ message, level }) => level === "warning" && /Duplicate/.test(message)));
	});

	test("redacts forbidden config fields recursively without mutating the source", () => {
		const source = {
			apiKey: "secret",
			default: { baseUrl: "https://example.invalid", model: "openai/main" },
			tasks: { summary: { headers: { Authorization: "secret" } } },
			list: [{ apiKey: "nested" }],
		};
		assert.deepEqual(redactConfigForDisplay(source), {
			apiKey: "[redacted]",
			default: { baseUrl: "[redacted]", model: "openai/main" },
			tasks: { summary: { headers: "[redacted]" } },
			list: [{ apiKey: "[redacted]" }],
		});
		assert.equal(source.apiKey, "secret");
	});

	test("resolves literal current for picker display", () => {
		assert.equal(resolveCurrentModelRef("current", "openai/main"), "openai/main");
		assert.equal(resolveCurrentModelRef("openai/pinned", "openai/main"), "openai/pinned");
		assert.equal(resolveCurrentModelRef("current", undefined), "current");
	});

	test("uses the real model picker for current selection, filtering, and cancellation", async () => {
		const providerDialogs: string[][] = [];
		const inputRuns = [
			["\r"],
			[..."gpt-a", "\r"],
			["\x1b"],
		];
		const models = [
			{ provider: "openai", id: "gpt-a", name: "GPT A" },
			{ provider: "openai", id: "gpt-b", name: "GPT B" },
		];
		const ctx = {
			model: models[1],
			modelRegistry: {
				find(provider: string, id: string) {
					return models.find((model) => model.provider === provider && model.id === id);
				},
			},
			ui: {
				async select(_title: string, options: string[]) {
					providerDialogs.push([...options]);
					return options[0];
				},
				async custom(factory: any) {
					let completed = false;
					let result: string | undefined;
					const component = await factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						getKeybindings(),
						(value: string | undefined) => {
							completed = true;
							result = value;
						},
					);
					for (const input of inputRuns.shift() ?? []) component.handleInput(input);
					assert.equal(completed, true);
					return result;
				},
				notify() {},
			},
		};
		const refs = ["openai/gpt-a", "openai/gpt-b"];

		assert.equal(await pickAvailableModel(ctx as never, "Model", "current", refs), "openai/gpt-b");
		assert.equal(await pickAvailableModel(ctx as never, "Model", "", refs), "openai/gpt-a");
		assert.equal(await pickAvailableModel(ctx as never, "Model", "", refs), undefined);
		assert.ok(providerDialogs[0]!.some((option) => option === "openai (2) [current]"));
	});

	test("keeps only unique available text model refs in stable order", () => {
		assert.deepEqual(availableTextModelRefs([
			{ provider: "zeta", id: "chat", input: ["text"] },
			{ provider: "alpha", id: "vision-only", input: ["image"] },
			{ provider: "alpha", id: "chat", input: ["text", "image"] },
			{ provider: "zeta", id: "chat", input: ["text"] },
		]), ["alpha/chat", "zeta/chat"]);
	});

	test("parses only bounded integers", () => {
		assert.deepEqual(parseRouteInteger("45000", "Timeout", 1_000, 600_000), { ok: true, value: 45_000 });
		assert.deepEqual(parseRouteInteger("1.5", "Timeout", 1_000, 600_000), {
			ok: false,
			error: "Timeout must be an integer from 1000 to 600000",
		});
		assert.equal(parseRouteInteger("999999", "Timeout", 1_000, 600_000).ok, false);
	});
});
