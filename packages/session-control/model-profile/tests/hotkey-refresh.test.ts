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

test("keeps dynamic default hotkeys and macOS aliases", async () => {
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
		let pickerOpens = 0;
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
		} as never, "darwin");
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
			ui: {
				notify: (message: string) => notifications.push(message),
				async custom() { pickerOpens += 1; return undefined; },
			},
		};

		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		assert.ok(shortcuts.has("alt+1"));
		assert.ok(shortcuts.has("alt+2"));
		assert.ok(shortcuts.has("ctrl+1"));
		assert.ok(shortcuts.has("ctrl+2"));
		assert.ok(shortcuts.has("ctrl+shift+l"));

		writeFileSync(configPath, JSON.stringify(config("alt+1", "gpt-new")), "utf8");
		await shortcuts.get("ctrl+1")!.handler(ctx);
		assert.equal(applied.at(-1), "gpt-new");

		writeFileSync(configPath, JSON.stringify({
			modelProfile: {
				...config("alt+1", "gpt-fallback").modelProfile,
				profiles: [
					config("alt+1", "gpt-fallback").modelProfile.profiles[0],
					{
						id: "2",
						alias: "exact",
						provider: "openai",
						model: "gpt-exact",
						thinking: "medium",
						hotkey: "ctrl+1",
					},
				],
			},
		}), "utf8");
		await shortcuts.get("ctrl+1")!.handler(ctx);
		assert.equal(applied.at(-1), "gpt-exact");

		writeFileSync(configPath, JSON.stringify(config("alt+1", "gpt-fallback")), "utf8");
		await shortcuts.get("ctrl+1")!.handler(ctx);
		assert.equal(applied.at(-1), "gpt-fallback");

		await shortcuts.get("ctrl+shift+l")!.handler(ctx);
		assert.equal(pickerOpens, 1);

		writeFileSync(configPath, JSON.stringify({
			modelProfile: {
				...config("alt+1", "gpt-new").modelProfile,
				profiles: [
					config("alt+1", "gpt-new").modelProfile.profiles[0],
					{
						id: "2",
						alias: "second",
						provider: "openai",
						model: "gpt-second",
						thinking: "medium",
						hotkey: "alt+2",
					},
				],
			},
		}), "utf8");
		await shortcuts.get("alt+2")!.handler(ctx);
		assert.equal(applied.at(-1), "gpt-second");

		writeFileSync(configPath, JSON.stringify(config("ctrl+alt+2", "gpt-new")), "utf8");
		const appliedBeforeUnbound = [...applied];
		await shortcuts.get("alt+2")!.handler(ctx);
		assert.deepEqual(applied, appliedBeforeUnbound);
		assert.match(notifications.at(-1) ?? "", /no longer bound/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
