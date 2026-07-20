import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
				label: "Daily",
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
