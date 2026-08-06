import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import modeExtension from "../extensions/mode.ts";

const PRESENTATION_EVENT = "terrific-pi:presentation:event-v1";

test("mode emits presentation events only for explicit successful user switches", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "mode-presentation-event-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({ mode: { default: "edit", persistPerSession: false } }), "utf8");
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		let tools = ["read", "grep", "find", "ls", "bash", "edit", "write"];
		const events: Array<{ name: string; value: any }> = [];
		const notifications: string[] = [];
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		let command: any;
		modeExtension({
			registerCommand(name: string, value: unknown) { if (name === "mode") command = value; },
			on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			getActiveTools: () => [...tools],
			setActiveTools(next: string[]) { tools = [...next]; },
			appendEntry() {},
			events: {
				emit(name: string, value: any) {
					events.push({ name, value: structuredClone(value) });
					value.presentationHandled = true;
				},
				on() { return () => {}; },
			},
		} as never);
		const ctx = {
			cwd: "/workspace",
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => false,
			ui: { notify(message: string) { notifications.push(message); }, setStatus() {}, select: async () => undefined },
			sessionManager: { getBranch: () => [] },
		};
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		assert.deepEqual(events, []);
		await command.handler("plan", ctx);
		assert.deepEqual(events, [{
			name: PRESENTATION_EVENT,
			value: {
				version: 1,
				kind: "mode",
				source: "user",
				tone: "info",
				label: "Mode",
				message: "PLAN · read-only",
				dedupeKey: "mode:plan",
			},
		}]);
		assert.deepEqual(notifications, []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
