import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import btwExtension from "../extensions/btw.ts";

it("labels the global BTW target separately from the effective project value", async () => {
	const root = mkdtempSync(join(tmpdir(), "btw-config-scope-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
		appearance: { profile: "off" },
		btw: { maxContextTokens: 5_000 },
	}));
	writeFileSync(join(projectDir, ".pi", "terrific.json"), JSON.stringify({ btw: { maxContextTokens: 1_234 } }));

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousTerm = process.env.TERM;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.TERM = "xterm-256color";
	try {
		let command: any;
		btwExtension({
			registerCommand(_name: string, value: unknown) { command = value; },
			on() {},
		} as never);
		assert.match(command.description, /context=current/);
		assert.deepEqual(command.getArgumentCompletions("").map((item: { value: string }) => item.value), [
			"status", "config", "context=current", "context=none",
		]);
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			appearance: { profile: "terrific-native-v1" },
			btw: { maxContextTokens: 5_000 },
		}));
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

		assert.match(rendered, /^╭─ BTW configuration/);
		assert.match(rendered, /write: global/);
		assert.match(rendered, /effective: 1234/);
		assert.match(rendered, /Write target context budget: 5000/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
});
