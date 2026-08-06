import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fastExtension from "../extensions/fast.ts";

const PRESENTATION_EVENT = "terrific-pi:presentation:event-v1";

test("fast emits an effective user preference event without emitting on restore", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "fast-presentation-event-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const events: Array<{ name: string; value: any }> = [];
		const notifications: string[] = [];
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		let command: any;
		fastExtension({
			registerCommand(name: string, value: unknown) { if (name === "fast") command = value; },
			on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			appendEntry() { throw new Error("fast must not append entries"); },
			events: {
				emit(name: string, value: any) {
					events.push({ name, value: structuredClone(value) });
					value.presentationHandled = true;
				},
				on() { return () => {}; },
			},
		} as never);
		const ctx = {
			mode: "tui",
			ui: { notify(message: string) { notifications.push(message); }, setStatus() {} },
			sessionManager: { getBranch: () => [] },
			model: { api: "openai-responses", id: "gpt-5.6-sol" },
		};
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		assert.deepEqual(events, []);
		await command.handler("on", ctx);
		assert.deepEqual(events, [{
			name: PRESENTATION_EVENT,
			value: {
				version: 1,
				kind: "fast",
				source: "user",
				tone: "success",
				label: "Fast",
				message: "ON · active",
				dedupeKey: "fast:on:active",
			},
		}]);
		assert.deepEqual(notifications, []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
