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
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({ btw: { maxContextTokens: 5_000 } }));
	writeFileSync(join(projectDir, ".pi", "terrific.json"), JSON.stringify({ btw: { maxContextTokens: 1_234 } }));

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		let command: any;
		btwExtension({
			registerCommand(_name: string, value: unknown) { command = value; },
			on() {},
		} as never);
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
		assert.match(title, /effective: 1234/);
		assert.ok(options.includes("Write target context budget: 5000"));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
