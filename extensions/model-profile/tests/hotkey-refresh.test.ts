import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import modelProfile from "../extensions/model-profile.ts";

function config(hotkey: string, model: string) {
	return {
		modelProfile: {
			startup: false,
			openHotkey: "ctrl+alt+l",
			profiles: [{
				id: "1",
				alias: "default",
				provider: "openai",
				model,
				thinking: "medium",
				hotkey,
			}],
		},
	};
}

test("registered hotkeys dispatch the latest file target and retire stale bindings", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "model-profile-live-hotkeys-"));
	const configPath = join(agentDir, "terrific.json");
	const settingsPath = join(agentDir, "settings.json");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(configPath, JSON.stringify(config("alt+1", "gpt-old")), "utf8");
	writeFileSync(settingsPath, "{}\n", "utf8");
	try {
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const shortcuts = new Map<string, { handler(ctx: any): Promise<void> }>();
		const applied: string[] = [];
		const notifications: string[] = [];
		let thinking = "medium";
		modelProfile({
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerCommand() {},
			registerShortcut(key: string, shortcut: { handler(ctx: any): Promise<void> }) {
				shortcuts.set(key, shortcut);
			},
			appendEntry() {},
			getThinkingLevel: () => thinking,
			setThinkingLevel(level: string) { thinking = level; },
			async setModel(model: { id: string }) { applied.push(model.id); return true; },
		} as never);
		const ctx = {
			cwd: agentDir,
			hasUI: true,
			mode: "tui",
			model: { provider: "openai", id: "gpt-current", reasoning: true },
			isProjectTrusted: () => false,
			sessionManager: { getSessionFile: () => undefined },
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
				getAvailable: () => [],
			},
			ui: { notify: (message: string) => notifications.push(message) },
		};

		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		assert.ok(shortcuts.has("alt+1"));

		writeFileSync(configPath, JSON.stringify(config("alt+1", "gpt-new")), "utf8");
		await shortcuts.get("alt+1")!.handler(ctx);
		assert.deepEqual(applied, ["gpt-new"]);

		writeFileSync(configPath, JSON.stringify(config("alt+2", "gpt-new")), "utf8");
		await shortcuts.get("alt+1")!.handler(ctx);
		assert.deepEqual(applied, ["gpt-new"]);
		assert.equal(shortcuts.has("alt+2"), false);
		assert.match(notifications.at(-1) ?? "", /no longer bound/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
