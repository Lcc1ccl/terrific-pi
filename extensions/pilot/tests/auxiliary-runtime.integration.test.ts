import assert from "node:assert/strict";
import { test } from "node:test";

import { AuxiliaryRuntime } from "../../auxiliary/lib/runtime.ts";
import {
	buildPilotRouterMessages,
	createPilotRouterBridge,
	parsePilotRouterOutput,
} from "../../auxiliary/lib/pilot-router.ts";
import type { AuxiliaryRouteConfig, AuxiliaryUsageEntryV1 } from "../../auxiliary/lib/types.ts";
import { requestPilotRoute, resolvePilotRoute } from "../lib/aux-router.ts";

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
} as never;

const route: AuxiliaryRouteConfig = {
	model: "test/router",
	thinking: "off",
	timeoutMs: 30,
	maxOutputTokens: 128,
	maxRetries: 0,
	fallbackModels: [],
};

const usage = {
	input: 4,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 6,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("routes one Pilot request through one AuxiliaryRuntime attempt using the bridge deadline", async () => {
	const events = new Events();
	const attempts: AuxiliaryUsageEntryV1[] = [];
	let calls = 0;
	const runtime = new AuxiliaryRuntime({
		registry: {
			find: () => model,
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test" }),
			getRegisteredProviderIds: () => [],
			getRegisteredProviderConfig: () => undefined,
		},
		getCurrentModel: () => model,
		createRuntime: async () => ({
			registerProvider() {},
			async completeSimple() {
				calls += 1;
				await new Promise((resolve) => setTimeout(resolve, 5));
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
		}) as never,
		onAttempt: (entry) => attempts.push(entry),
	});
	const bridge = createPilotRouterBridge({
		events,
		timeoutMs: () => route.timeoutMs,
		run: async (prompt, signal) => {
			const result = await runtime.call({
				task: "pilot_router",
				executor: "call",
				adapter: "pilot_router:v1",
				messages: buildPilotRouterMessages(prompt),
				requiredInput: "text",
				signal,
				validateOutput: (text) => JSON.stringify(parsePilotRouterOutput(text)),
			}, route);
			return parsePilotRouterOutput(result.text);
		},
	});

	const response = await requestPilotRoute({ events, prompt: "Explain this module", timeoutMs: 1 });
	assert.equal(resolvePilotRoute(response).route, "ask");
	assert.equal(calls, 1);
	assert.equal(attempts.length, 1);
	assert.equal(attempts[0]?.task, "pilot_router");
	assert.equal(attempts[0]?.status, "ok");
	bridge.close();
});
