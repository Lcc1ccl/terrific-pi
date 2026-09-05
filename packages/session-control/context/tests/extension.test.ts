import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import contextExtension from "../extensions/context.ts";

it("reports safe input headroom after reserving the model output budget", async () => {
	let command: any;
	contextExtension({ registerCommand(_name: string, value: unknown) { command = value; } } as never);
	const notifications: string[] = [];
	await command.handler("summary", {
		cwd: "/tmp/context-safe-headroom",
		hasUI: true,
		mode: "rpc",
		isProjectTrusted: () => false,
		model: { maxTokens: 128_000 },
		getContextUsage: () => ({ tokens: 340_000, contextWindow: 500_000, percent: 68 }),
		getSystemPrompt: () => "system",
		sessionManager: { getEntries: () => [], getLeafId: () => undefined },
		ui: { notify(message: string) { notifications.push(message); } },
	});
	assert.match(notifications[0] ?? "", /Safe input 340,000 \/ 355,616 · 95\.6%/);
	assert.match(notifications[0] ?? "", /Safe remaining 15,616/);
});

it("runs confirmed compaction only from the dedicated x action", async () => {
	let command: any;
	let compactCalls = 0;
	const pi = {
		registerCommand(_name: string, value: unknown) { command = value; },
	};
	contextExtension(pi as never);
	const keys = ["x"];
	const ctx = {
		cwd: "/tmp/context-test",
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: 10, contextWindow: 1_000, percent: 1 }),
		getSystemPrompt: () => "system",
		sessionManager: {
			getEntries: () => [],
			getLeafId: () => undefined,
		},
		compact: () => { compactCalls += 1; },
		ui: {
			notify() {},
			confirm: async () => true,
			custom: async (factory: any) => new Promise((resolve) => {
				let done = false;
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text },
					{},
					(value: unknown) => { done = true; resolve(value); },
				);
				component.handleInput(keys.shift() ?? "\x1b");
				if (!done) component.handleInput("\x1b");
			}),
		},
	};

	await command.handler("", ctx);
	assert.equal(compactCalls, 1);
});

it("labels the global context target separately from the effective project value", async () => {
	const root = mkdtempSync(join(tmpdir(), "context-config-scope-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({ context: { topEntries: 9 } }));
	writeFileSync(join(projectDir, ".pi", "terrific.json"), JSON.stringify({ context: { topEntries: 3 } }));

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		let command: any;
		contextExtension({ registerCommand(_name: string, value: unknown) { command = value; } } as never);
		let rendered = "";
		await command.handler("config", {
			cwd: projectDir,
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => true,
			ui: {
				select: async () => undefined,
				custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
					const component = factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{
							matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\x1b",
							getKeys: () => [],
						},
						resolve,
					);
					rendered = component.render(200).join("\n");
					component.handleInput("\x1b");
				}),
				notify() {},
				confirm: async () => false,
			},
		});

		assert.match(rendered, /write: global/);
		assert.match(rendered, /effective: 3/);
		assert.match(rendered, /Write target top entries: 9/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
