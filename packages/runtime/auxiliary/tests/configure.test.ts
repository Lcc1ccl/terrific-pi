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

type ScriptedOption = string | { value: string; label?: string; description?: string };

class ScriptedUi implements AuxiliaryConfiguratorUi {
	readonly notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
	readonly dialogs: Array<{ title: string; options: string[]; descriptions: Record<string, string> }> = [];
	readonly confirmDialogs: Array<{ title: string; message: string }> = [];
	private readonly choices: string[];
	private readonly inputs: string[];
	private readonly models: string[];
	private readonly confirmations: boolean[];
	private readonly onConfirm?: () => void;

	constructor(
		choices: string[],
		inputs: string[] = [],
		models: string[] = [],
		confirmations: boolean[] = [],
		onConfirm?: () => void,
	) {
		this.choices = choices;
		this.inputs = inputs;
		this.models = models;
		this.confirmations = confirmations;
		this.onConfirm = onConfirm;
	}

	async select(title: string, options: ScriptedOption[]): Promise<string | undefined> {
		const normalized = options.map((option) => typeof option === "string"
			? { value: option, label: option, description: undefined }
			: { value: option.value, label: option.label ?? option.value, description: option.description });
		this.dialogs.push({
			title,
			options: normalized.map((option) => option.label),
			descriptions: Object.fromEntries(normalized.flatMap((option) =>
				option.description ? [[option.label, option.description]] : [])),
		});
		const prefix = this.choices.shift();
		if (prefix === undefined) return undefined;
		const choice = normalized.find((option) => option.label === prefix || option.label.startsWith(prefix));
		assert.ok(choice, `No option starts with ${JSON.stringify(prefix)} in ${JSON.stringify(normalized.map((option) => option.label))}`);
		return choice.value;
	}

	async input(): Promise<string | undefined> {
		return this.inputs.shift();
	}

	async confirm(title: string, message: string): Promise<boolean> {
		this.confirmDialogs.push({ title, message });
		const confirmed = this.confirmations.shift() ?? false;
		if (confirmed) this.onConfirm?.();
		return confirmed;
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

	test("keeps exactly six public routes without a vision replacement", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-hidden-routes-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({ auxiliary: {} }), "utf8");
		const ui = new ScriptedUi(["Runtime", "Disabled", "Done"]);

		await runAuxiliaryConfigurator({
			agentDir,
			modelRefs: [],
			ui,
		});

		const main = ui.dialogs[0];
		assert.ok(main);
		assert.deepEqual(
			main.options
				.filter((option) => /^(compression|title_generation|text_summary|commit_message|btw|web_research):/.test(option))
				.map((option) => option.split(":", 1)[0]),
			["compression", "title_generation", "text_summary", "commit_message", "btw", "web_research"],
		);
		assert.equal(main.options.some((option) => option.startsWith("pilot_router")), false);
		assert.equal(main.options.some((option) => /vision/i.test(option)), false);
		assert.equal(readConfig(agentDir).auxiliary.tasks?.vision, undefined);
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

	test("applies the default primary model to every task and enables auxiliary routing", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-apply-all-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			auxiliary: {
				default: { model: "openai/gpt-5.6-sol", futureDefault: "keep" },
				tasks: {
					compression: { useAuxiliary: false, timeoutMs: 45_000, futureTask: "keep" },
					title_generation: { model: "openai/old-title", thinking: "low" },
					custom_task: { model: "openai/custom" },
				},
			},
		}), "utf8");
		const ui = new ScriptedUi([
			"Default route",
			"Apply primary model to all tasks",
			"Back",
			"Done",
		], [], [], [true]);

		await runAuxiliaryConfigurator({
			agentDir,
			modelRefs: ["openai/gpt-5.6-sol"],
			ui,
		});

		const auxiliary = readConfig(agentDir).auxiliary;
		for (const task of ["compression", "title_generation", "text_summary", "commit_message", "btw", "web_research"]) {
			assert.equal(auxiliary.tasks[task].model, "openai/gpt-5.6-sol", task);
			assert.notEqual(auxiliary.tasks[task].useAuxiliary, false, task);
		}
		assert.deepEqual(auxiliary.default, { model: "openai/gpt-5.6-sol", futureDefault: "keep" });
		assert.deepEqual(auxiliary.tasks.compression, {
			model: "openai/gpt-5.6-sol",
			timeoutMs: 45_000,
			futureTask: "keep",
		});
		assert.deepEqual(auxiliary.tasks.title_generation, {
			model: "openai/gpt-5.6-sol",
			thinking: "low",
		});
		assert.deepEqual(auxiliary.tasks.custom_task, { model: "openai/custom" });
	});

	test("does not apply the default model when bulk confirmation is cancelled", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-apply-all-cancel-"));
		const original = {
			auxiliary: {
				default: { model: "openai/gpt-5.6-sol" },
				tasks: { compression: { useAuxiliary: false, model: "openai/old" } },
			},
		};
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify(original), "utf8");
		const ui = new ScriptedUi([
			"Default route",
			"Apply primary model to all tasks",
			"Back",
			"Done",
		], [], [], [false]);

		await runAuxiliaryConfigurator({ agentDir, modelRefs: ["openai/gpt-5.6-sol"], ui });

		assert.deepEqual(readConfig(agentDir), original);
	});

	test("describes route limits, bulk application, reset scope, and Git policy impact", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-tips-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			auxiliary: {
				default: { model: "openai/default", maxOutputTokens: 4_096 },
				tasks: { compression: { model: "openai/compression" } },
			},
		}), "utf8");
		const ui = new ScriptedUi([
			"Default route",
			"Back",
			"compression",
			"Back",
			"Git finalize policy",
			"Back",
			"Done",
		]);

		await runAuxiliaryConfigurator({ agentDir, modelRefs: ["openai/default", "openai/compression"], ui });

		const main = ui.dialogs.find((item) => item.title.startsWith("Auxiliary Models"));
		assert.ok(main);
		const defaultMain = main.options.find((option) => option.startsWith("Default route"));
		assert.ok(defaultMain);
		assert.match(main.descriptions[defaultMain] ?? "", /task-specific.*override/i);

		const defaultRoute = ui.dialogs.find((item) => item.title === "Default route");
		assert.ok(defaultRoute);
		assert.match(defaultRoute.descriptions["Apply primary model to all tasks"] ?? "", /enable.*all six/i);
		const output = defaultRoute.options.find((option) => option.startsWith("Max output tokens"));
		assert.ok(output);
		assert.match(defaultRoute.descriptions[output] ?? "", /generated.*not.*input.*context/i);
		assert.match(defaultRoute.descriptions["Reset default route"] ?? "", /package defaults.*task overrides.*unchanged/i);

		const taskRoute = ui.dialogs.find((item) => item.title === "compression");
		assert.ok(taskRoute);
		assert.match(taskRoute.descriptions["Reset task overrides"] ?? "", /package preset.*default route/i);

		const git = ui.dialogs.find((item) => item.title === "Git finalize policy");
		assert.ok(git);
		const headless = git.options.find((option) => option.startsWith("Allow headless"));
		const push = git.options.find((option) => option.startsWith("Allow push"));
		assert.ok(headless);
		assert.ok(push);
		assert.match(git.descriptions[headless] ?? "", /without interactive confirmation/i);
		assert.match(git.descriptions[push] ?? "", /explicit.*existing upstream/i);
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
		assert.match(ui.confirmDialogs[0]?.message ?? "", /After reset: model openai\/gpt-5\.4-mini.*thinking off.*timeout 60000 ms.*max output 2048.*retries 1.*fallbacks none/i);
		assert.match(ui.confirmDialogs[0]?.message ?? "", /task overrides stay unchanged/i);
		assert.match(ui.confirmDialogs[1]?.message ?? "", /After reset: model openai\/gpt-5\.4-mini.*thinking low.*timeout 120000 ms.*max output 12000.*fallbacks none/i);
		assert.match(ui.confirmDialogs[1]?.message ?? "", /auxiliary routing returns to enabled/i);
	});

	test("aborts a reset when its effective preview changes during confirmation", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-reset-race-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({
			auxiliary: {
				default: { model: "openai/old-default" },
				tasks: { compression: { model: "openai/compression" } },
			},
		}), "utf8");
		const ui = new ScriptedUi([
			"compression",
			"Reset task overrides",
			"Back",
			"Done",
		], [], [], [true], () => {
			const current = readConfig(agentDir);
			current.auxiliary.default.model = "openai/new-default";
			writeFileSync(path, JSON.stringify(current), "utf8");
		});

		await runAuxiliaryConfigurator({ agentDir, modelRefs: [], ui });

		const auxiliary = readConfig(agentDir).auxiliary;
		assert.equal(auxiliary.default.model, "openai/new-default");
		assert.equal(auxiliary.tasks.compression.model, "openai/compression");
		assert.ok(ui.notifications.some(({ message, level }) =>
			level === "error" && /changed while confirming reset/i.test(message)));
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

	test("shows only route fields consumed by Compression, BTW, and Web Research", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "aux-configure-capabilities-"));
		const ui = new ScriptedUi([
			"compression",
			"Back",
			"btw",
			"Back",
			"web_research",
			"Back",
			"Done",
		]);

		await runAuxiliaryConfigurator({ agentDir, modelRefs: [], ui });

		const compression = ui.dialogs.find((item) => item.title === "compression");
		assert.ok(compression);
		assert.ok(compression.options.some((option) => option.startsWith("Max output tokens")));
		assert.equal(compression.options.some((option) => option.startsWith("Retries")), false);

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
