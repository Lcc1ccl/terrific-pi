import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import modelProfileExtension from "../extensions/model-profile.ts";

it("routes the profile manager through its wrapping TUI selector", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "model-profile-manager-menu-"));
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
		modelProfile: {
			profiles: [{
				id: "1",
				alias: "daily",
				provider: "openai",
				model: "gpt-test",
				thinking: "medium",
			}],
		},
	}), "utf8");

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		let command: { handler(args: string, ctx: unknown): Promise<void> } | undefined;
		modelProfileExtension({
			on() {},
			registerCommand(_name: string, value: typeof command) { command = value; },
			registerShortcut() {},
			appendEntry() {},
			getThinkingLevel: () => "medium",
			setThinkingLevel() {},
			setModel: async () => true,
		} as never);

		assert.deepEqual((command as any).getArgumentCompletions("sta").map((item: { value: string }) => item.value), ["status", "startup", "startup on", "startup off"]);
		const notifications: string[] = [];
		await command!.handler("status extra", {
			cwd: agentDir,
			hasUI: false,
			mode: "tui",
			isProjectTrusted: () => false,
			ui: { notify: (message: string) => notifications.push(message) },
		});
		assert.match(notifications.at(-1) ?? "", /Usage:/);

		let customCalls = 0;
		let coreSelectCalls = 0;
		let rendered = "";
		await command!.handler("", {
			cwd: agentDir,
			hasUI: true,
			mode: "tui",
			model: { provider: "openai", id: "gpt-test" },
			isProjectTrusted: () => false,
			modelRegistry: { refresh: async () => {}, getAvailable: () => [], find() {} },
			ui: {
				select: async () => {
					coreSelectCalls += 1;
					return undefined;
				},
				custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
					customCalls += 1;
					const component = factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{
							matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\x1b",
							getKeys: (binding: string) => ({
								"tui.select.up": ["up"],
								"tui.select.down": ["down"],
								"tui.select.confirm": ["enter"],
								"tui.select.cancel": ["escape"],
							}[binding] ?? []),
						},
						resolve,
					);
					rendered = component.render(100).join("\n");
					component.handleInput("\x1b");
				}),
				notify() {},
			},
		});

		assert.equal(coreSelectCalls, 0);
		assert.equal(customCalls, 1);
		assert.match(rendered, /Model profiles/);
		assert.match(rendered, /Esc cancel/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

it("preselects the current provider when creating a profile", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "model-profile-current-provider-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		let command: { handler(args: string, ctx: unknown): Promise<void> } | undefined;
		modelProfileExtension({
			on() {},
			registerCommand(_name: string, value: typeof command) { command = value; },
			registerShortcut() {},
			appendEntry() {},
			getThinkingLevel: () => "medium",
			setThinkingLevel() {},
			setModel: async () => true,
		} as never);

		const models = [
			{ provider: "anthropic", id: "claude-test", name: "Claude Test", reasoning: true },
			{ provider: "openai", id: "gpt-current", name: "GPT Current", reasoning: true },
		];
		let managerVisits = 0;
		await command!.handler("", {
			cwd: agentDir,
			hasUI: true,
			mode: "tui",
			model: models[1],
			isProjectTrusted: () => false,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => models,
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			},
			ui: {
				input: async (title: string) => title.startsWith("Profile alias") ? "picked" : "",
				confirm: async () => false,
				custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
					const component = factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{
							matches: (data: string, binding: string) =>
								(data === "d" && binding === "tui.select.down")
								|| (data === "e" && binding === "tui.select.confirm")
								|| (data === "x" && binding === "tui.select.cancel"),
							getKeys: () => [],
						},
						resolve,
					);
					const rendered = component.render(120).join("\n");
					if (/Model profiles/.test(rendered)) {
						managerVisits += 1;
						if (managerVisits === 1) {
							component.handleInput("d");
							component.handleInput("e");
						} else component.handleInput("x");
					} else if (/Create profile/.test(rendered)) {
						component.handleInput("d");
						component.handleInput("e");
					} else if (/Profile model: provider/.test(rendered)) {
						component.handleInput("e");
					} else if (/Profile model: /.test(rendered) || /Profile thinking/.test(rendered)) {
						component.handleInput("e");
					} else {
						assert.fail(`Unexpected dialog:\n${rendered}`);
					}
				}),
				notify() {},
			},
		});

		const saved = JSON.parse(readFileSync(join(agentDir, "terrific.json"), "utf8"));
		assert.equal(saved.modelProfile.profiles[0].provider, "openai");
		assert.equal(saved.modelProfile.profiles[0].model, "gpt-current");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
