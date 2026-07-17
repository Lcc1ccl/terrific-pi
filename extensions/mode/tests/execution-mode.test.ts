import assert from "node:assert/strict";
import { it } from "node:test";
import modeExtension from "../extensions/mode.ts";

it("restores startup tools before reload", async () => {
	let tools = ["read", "bash", "edit", "write"];
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	modeExtension({
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getActiveTools: () => [...tools],
		setActiveTools: (next: string[]) => { tools = [...next]; },
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as never);
	const ctx = {
		cwd: "/tmp/pi-mode-test",
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => false,
		ui: { notify() {}, setStatus() {}, select: async () => undefined },
		sessionManager: { getBranch: () => entries },
	};
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	await commands.get("mode")!.handler("ask", ctx);
	assert.deepEqual(tools, ["read", "grep", "find", "ls"]);
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
	assert.deepEqual(tools, ["read", "bash", "edit", "write"]);
});
