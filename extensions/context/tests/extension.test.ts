import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import contextExtension from "../extensions/context.ts";

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
		let title = "";
		let options: string[] = [];
		await command.handler("config", {
			cwd: projectDir,
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => true,
			ui: {
				select: async (nextTitle: string, nextOptions: string[]) => {
					title = nextTitle;
					options = nextOptions;
					return undefined;
				},
				notify() {},
				confirm: async () => false,
			},
		});

		assert.match(title, /write: global/);
		assert.match(title, /effective: 3/);
		assert.ok(options.includes("Write target top entries: 9"));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
