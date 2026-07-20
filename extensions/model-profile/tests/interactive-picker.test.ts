import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import modelProfileExtension from "../extensions/model-profile.ts";

describe("Quick apply picker", () => {
	it("returns from scope to profiles and only cancels from the top level", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-quick-picker-"));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			modelProfile: {
				profiles: [{
					id: 1,
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
			let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
			const pi = {
				on() {},
				registerCommand(_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
					commandHandler = command.handler;
				},
				registerShortcut() {},
				appendEntry() {},
				getThinkingLevel: () => "medium",
				setThinkingLevel() {},
				setModel: async () => true,
			};
			modelProfileExtension(pi as never);

			const renders: string[] = [];
			let customCalls = 0;
			const inputs = ["\r", "\r", "\x1b", "\x1b"];
			const ctx: any = {
				cwd: agentDir,
				hasUI: true,
				mode: "tui",
				model: { provider: "openai", id: "gpt-test" },
				isProjectTrusted: () => false,
				modelRegistry: {
					refresh: async () => {},
					getAvailable: () => [],
					find: (provider: string, id: string) => ({ provider, id }),
				},
				ui: {
					select: async () => undefined,
					custom: async (factory: any) => new Promise((resolve) => {
						customCalls += 1;
						const component = factory(
							{ requestRender() {} },
							{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
							{
								matches: (data: string, key: string) => key === "tui.select.cancel" && data === "\x1b",
								getKeys: (key: string) => ({
									"tui.select.up": ["up"],
									"tui.select.down": ["down"],
									"tui.select.confirm": ["enter"],
									"tui.select.cancel": ["escape"],
								}[key] ?? []),
							},
							resolve,
						);
						renders.push(component.render(100).join("\n"));
						component.handleInput(inputs.shift() ?? "\x1b");
					}),
					notify() {},
				},
			};

			await commandHandler?.("", ctx);

			assert.equal(customCalls, 5);
			assert.match(renders[0] ?? "", /Model profiles/);
			assert.match(renders[0] ?? "", /Esc cancel/);
			assert.match(renders[1] ?? "", /Model profile/);
			assert.match(renders[1] ?? "", /Up\/Down navigate/);
			assert.match(renders[1] ?? "", /Enter select/);
			assert.match(renders[1] ?? "", /Esc cancel/);
			assert.match(renders[2] ?? "", /Apply scope/);
			assert.match(renders[2] ?? "", /Up\/Down navigate/);
			assert.match(renders[2] ?? "", /Enter select/);
			assert.match(renders[2] ?? "", /Esc back/);
			assert.match(renders[3] ?? "", /Model profile/);
			assert.match(renders[3] ?? "", /Esc cancel/);
			assert.match(renders[4] ?? "", /Model profiles/);
			assert.match(renders[4] ?? "", /Esc cancel/);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});
