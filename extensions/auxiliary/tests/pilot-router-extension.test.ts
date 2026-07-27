import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model, Usage } from "@earendil-works/pi-ai";

import {
	PILOT_ROUTER_REQUEST_EVENT,
	PILOT_ROUTER_RESPONSE_EVENT,
} from "../lib/pilot-router.ts";
import auxiliary from "../extensions/auxiliary.ts";
import { AUXILIARY_USAGE_CHANGED_EVENT, AUXILIARY_USAGE_ENTRY_TYPE } from "../lib/usage.ts";

class Events {
	private readonly handlers = new Map<string, Array<(value: unknown) => void>>();

	on(name: string, handler: (value: unknown) => void): () => void {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
		return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
	}

	emit(name: string, value: unknown): void {
		for (const handler of this.handlers.get(name) ?? []) handler(value);
	}
}

const model = {
	id: "router",
	name: "router",
	provider: "test",
	api: "test-api",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4_096,
} as Model<any>;

const usage: Usage = {
	input: 4,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 6,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("the Auxiliary extension records exactly one usage entry for a Pilot router request", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "aux-pilot-router-extension-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalCreate = ModelRuntime.create;
	let calls = 0;
	const fakeRuntime = {
		registerProvider() {},
		async completeSimple() {
			calls += 1;
			return {
				role: "assistant",
				content: [{ type: "text", text: '{"route":"ask","confidence":0.9,"reasons":["question"],"riskFlags":[]}' }],
				api: "test-api",
				provider: "test",
				model: "router",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			};
		},
		streamSimple() { throw new Error("not used"); },
	};

	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({ auxiliary: { default: { model: "test/router" } } }));
	(ModelRuntime as unknown as { create: typeof ModelRuntime.create }).create = async () => fakeRuntime as never;
	try {
		const events = new Events();
		const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
		const entries: Array<{ customType: string; data: unknown }> = [];
		const usageEvents: unknown[] = [];
		events.on(AUXILIARY_USAGE_CHANGED_EVENT, (value) => usageEvents.push(value));
		auxiliary({
			events,
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: any) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
			appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
			setSessionName() {},
			getSessionName() { return undefined; },
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
			getActiveTools() { return ["read", "grep", "find", "ls"]; },
			setActiveTools() {},
		} as never);
		const ctx = {
			cwd: "/workspace",
			hasUI: false,
			mode: "print",
			model,
			modelRegistry: {
				find: () => model,
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test" }),
				getRegisteredProviderIds: () => [],
				getRegisteredProviderConfig: () => undefined,
			},
			ui: { notify() {}, setStatus() {} },
			sessionManager: { getBranch: () => entries },
		};
		for (const handler of hooks.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);

		const response = await new Promise<Record<string, unknown>>((resolve) => {
			const requestId = "compatibility-test";
			events.on(PILOT_ROUTER_RESPONSE_EVENT, (value) => {
				if ((value as { requestId?: unknown }).requestId === requestId) resolve(value as Record<string, unknown>);
			});
			events.emit(PILOT_ROUTER_REQUEST_EVENT, {
				version: 1,
				requestId,
				prompt: "Explain this module",
			});
		});
		assert.equal(response.status, "completed");
		assert.equal((response.decision as { route?: unknown }).route, "ask");
		assert.equal(calls, 1);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.customType, AUXILIARY_USAGE_ENTRY_TYPE);
		assert.equal((entries[0]?.data as { task?: string }).task, "pilot_router");
		assert.equal(usageEvents.length, 1);
		for (const handler of hooks.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
	} finally {
		(ModelRuntime as unknown as { create: typeof ModelRuntime.create }).create = originalCreate;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
