import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	InMemoryCredentialStore,
	createFauxCore,
	fauxAssistantMessage,
	type AssistantMessage,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { AuxiliaryError, AuxiliaryRuntime } from "../lib/runtime.ts";
import type { AuxiliaryRouteConfig, AuxiliaryUsageEntryV1 } from "../lib/types.ts";

const usage: Usage = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

function model(provider: string, id: string, input: ("text" | "image")[] = ["text"]): Model<any> {
	return {
		id,
		name: id,
		provider,
		api: "test-api",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
	};
}

function response(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "test-api",
		provider: "openai",
		model: "small",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

const route: AuxiliaryRouteConfig = {
	model: "openai/small",
	thinking: "off",
	timeoutMs: 5_000,
	maxOutputTokens: 500,
	maxRetries: 0,
	fallbackModels: [],
};

function harness(outputs: Array<AssistantMessage | Error>, models = [model("openai", "small"), model("grok", "fallback")]) {
	const attempts: AuxiliaryUsageEntryV1[] = [];
	const active: string[] = [];
	const calls: string[] = [];
	const fakeRuntime = {
		registerProvider() {},
		async completeSimple(selectedModel: Model<any>, _context: unknown, options: { signal?: AbortSignal }) {
			calls.push(`${selectedModel.provider}/${selectedModel.id}`);
			const next = outputs.shift();
			if (next instanceof Error) throw next;
			if (!next) throw new Error("missing fixture");
			if (options.signal?.aborted) return response("", { stopReason: "aborted" });
			return next;
		},
		streamSimple() { throw new Error("not used"); },
	};
	const registry = {
		find(provider: string, id: string) { return models.find((item) => item.provider === provider && item.id === id); },
		async getApiKeyAndHeaders(selected: Model<any>) {
			return selected.id === "no-auth" ? { ok: false as const, error: "missing" } : { ok: true as const, apiKey: "ephemeral", headers: { "x-test": "1" }, env: {} };
		},
		getRegisteredProviderIds() { return []; },
		getRegisteredProviderConfig() { return undefined; },
	};
	const runtime = new AuxiliaryRuntime({
		registry,
		getCurrentModel: () => models[0],
		createRuntime: async () => fakeRuntime,
		onAttempt: (entry) => attempts.push(entry),
		onActiveChange: (label) => active.push(label ?? ""),
	});
	return { runtime, attempts, active, calls };
}

const request = {
	task: "text_summary" as const,
	executor: "call" as const,
	adapter: "summary",
	requiredInput: "text" as const,
	messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }], timestamp: Date.now() }],
};

describe("AuxiliaryRuntime", () => {
	test("calls the configured model and records bounded usage metadata", async () => {
		const { runtime, attempts, active } = harness([response("ok")]);
		const result = await runtime.call(request, route);
		assert.equal(result.text, "ok");
		assert.equal(result.model, "small");
		assert.equal(attempts.length, 1);
		assert.deepEqual(Object.keys(attempts[0]!).sort(), [
			"durationMs", "executor", "fallbackIndex", "id", "model", "provider", "startedAt", "status", "task", "thinking", "usage", "version",
		].sort());
		assert.deepEqual(active, ["aux text_summary · small", ""]);
	});

	test("falls back after a provider failure", async () => {
		const { runtime, attempts } = harness([new Error("network"), response("fallback", { provider: "grok", model: "fallback" })]);
		const result = await runtime.call(request, { ...route, fallbackModels: ["grok/fallback"] });
		assert.equal(result.text, "fallback");
		assert.equal(result.fallbackIndex, 1);
		assert.deepEqual(attempts.map((entry) => entry.status), ["error", "ok"]);
	});

	test("deduplicates current and explicit refs that resolve to the same model", async () => {
		const { runtime, attempts, calls } = harness([
			new Error("network"),
			response("fallback", { provider: "grok", model: "fallback" }),
		]);
		const result = await runtime.call(request, {
			...route,
			model: "current",
			fallbackModels: ["openai/small", "grok/fallback"],
		});
		assert.equal(result.text, "fallback");
		assert.deepEqual(calls, ["openai/small", "grok/fallback"]);
		assert.deepEqual(attempts.map((entry) => entry.status), ["error", "ok"]);
	});

	test("does not fall back after adapter validation fails", async () => {
		const { runtime, attempts } = harness([response("bad"), response("unused")]);
		await assert.rejects(
			runtime.call({ ...request, validateOutput: () => { throw new AuxiliaryError("invalid_output", "bad output"); } }, { ...route, fallbackModels: ["grok/fallback"] }),
			(error: unknown) => error instanceof AuxiliaryError && error.code === "invalid_output",
		);
		assert.equal(attempts.length, 1);
		assert.equal(attempts[0]!.status, "error");
	});

	test("suppresses usage when request ownership expires", async () => {
		const { runtime, attempts } = harness([response("unused")]);
		await runtime.call({ ...request, shouldRecordAttempt: () => false }, route);
		assert.equal(attempts.length, 0);
	});

	test("accepts an image-capable model for image-required calls", async () => {
		const { runtime, attempts } = harness([response("ok")], [model("openai", "small", ["text", "image"])]);
		const result = await runtime.call({ ...request, requiredInput: "image" }, route);
		assert.equal(result.text, "ok");
		assert.equal(attempts[0]?.status, "ok");
	});

	test("rejects an unsupported input modality before a provider call", async () => {
		const { runtime, attempts } = harness([], [model("openai", "small", ["image"])]);
		await assert.rejects(runtime.call(request, route), (error: unknown) => error instanceof AuxiliaryError && error.code === "unsupported_input");
		assert.equal(attempts.length, 1);
	});

	test("distinguishes user abort from timeout", async () => {
		const abortedController = new AbortController();
		abortedController.abort();
		const aborted = harness([]);
		await assert.rejects(aborted.runtime.call({ ...request, signal: abortedController.signal }, route), (error: unknown) => error instanceof AuxiliaryError && error.code === "aborted");

		const timeoutRuntime = new AuxiliaryRuntime({
			registry: {
				find: () => model("openai", "small"),
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "ephemeral" }),
				getRegisteredProviderIds: () => [],
				getRegisteredProviderConfig: () => undefined,
			},
			getCurrentModel: () => undefined,
			createRuntime: async () => ({
				registerProvider() {},
				streamSimple() { throw new Error("not used"); },
				completeSimple: async (_model: Model<any>, _context: unknown, options: { signal?: AbortSignal }) => await new Promise<AssistantMessage>((resolve, reject) => {
					const guard = setTimeout(() => resolve(response("late")), 100);
					options.signal?.addEventListener("abort", () => {
						clearTimeout(guard);
						reject(new Error("provider aborted the stream"));
					}, { once: true });
				}),
			}),
		});
		await assert.rejects(timeoutRuntime.call(request, { ...route, timeoutMs: 10 }), (error: unknown) => error instanceof AuxiliaryError && error.code === "timeout");
	});

	test("rejects truncated output without falling back", async () => {
		const { runtime, attempts } = harness([response("partial", { stopReason: "length" }), response("unused")]);
		await assert.rejects(
			runtime.call(request, { ...route, fallbackModels: ["grok/fallback"] }),
			(error: unknown) => error instanceof AuxiliaryError && error.code === "invalid_output",
		);
		assert.equal(attempts.length, 1);
		assert.equal(attempts[0]!.errorCode, "invalid_output");
	});

	test("treats whitespace-only responses as retryable empty responses", async () => {
		const { runtime } = harness([response("   "), response("usable", { provider: "grok", model: "fallback" })]);
		const result = await runtime.call(request, { ...route, fallbackModels: ["grok/fallback"] });
		assert.equal(result.text, "usable");
	});

	test("uses Pi native compaction and aggregates split-call usage", async () => {
		const faux = createFauxCore({
			provider: "aux-compact",
			api: "aux-compact",
			models: [{ id: "small", reasoning: true, contextWindow: 20_000, maxTokens: 2_000 }],
		});
		faux.setResponses([fauxAssistantMessage("history summary"), fauxAssistantMessage("turn prefix summary")]);
		const sidecar = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
		sidecar.registerProvider("aux-compact", {
			name: "Aux compact",
			api: "aux-compact",
			apiKey: "$AUX_TEST_KEY",
			models: faux.models.map((item) => ({ ...item, name: item.name ?? item.id })),
			streamSimple: faux.streamSimple,
		});
		const selected = sidecar.getModel("aux-compact", "small")!;
		const attempts: AuxiliaryUsageEntryV1[] = [];
		const runtime = new AuxiliaryRuntime({
			registry: {
				find: () => selected,
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "ephemeral" }),
				getRegisteredProviderIds: () => [],
				getRegisteredProviderConfig: () => undefined,
			},
			getCurrentModel: () => undefined,
			createRuntime: async () => sidecar,
			onAttempt: (entry) => attempts.push(entry),
		});
		const result = await runtime.compact({
			preparation: {
				firstKeptEntryId: "kept",
				messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old history" }], timestamp: Date.now() }],
				turnPrefixMessages: [{ role: "user", content: [{ type: "text", text: "large current turn" }], timestamp: Date.now() }],
				isSplitTurn: true,
				tokensBefore: 4_000,
				fileOps: { read: new Set(["read.ts"]), written: new Set(), edited: new Set(["edit.ts"]) },
				settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 500 },
			},
			signal: new AbortController().signal,
		}, { ...route, model: "aux-compact/small", thinking: "low", maxOutputTokens: 1_000 });
		assert.equal(result.firstKeptEntryId, "kept");
		assert.match(result.summary, /history summary/);
		assert.match(result.summary, /turn prefix summary/);
		assert.deepEqual(result.details, { readFiles: ["read.ts"], modifiedFiles: ["edit.ts"] });
		assert.equal(attempts.length, 1);
		assert.equal(attempts[0]!.status, "ok");
		assert.equal(faux.state.callCount, 2);
	});

	test("deduplicates current and explicit fallback models for compaction", async () => {
		const faux = createFauxCore({
			provider: "aux-dedupe",
			api: "aux-dedupe",
			models: [
				{ id: "small", reasoning: true, contextWindow: 20_000, maxTokens: 2_000 },
				{ id: "fallback", reasoning: true, contextWindow: 20_000, maxTokens: 2_000 },
			],
		});
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error" }),
			(_context, _options, _state, selected) => fauxAssistantMessage(`${selected.id} summary`),
		]);
		const sidecar = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
		sidecar.registerProvider("aux-dedupe", {
			name: "Aux dedupe",
			api: "aux-dedupe",
			apiKey: "$AUX_TEST_KEY",
			models: faux.models.map((item) => ({ ...item, name: item.name ?? item.id })),
			streamSimple: faux.streamSimple,
		});
		const current = sidecar.getModel("aux-dedupe", "small")!;
		const attempts: AuxiliaryUsageEntryV1[] = [];
		const runtime = new AuxiliaryRuntime({
			registry: {
				find: (provider, id) => sidecar.getModel(provider, id),
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "ephemeral" }),
				getRegisteredProviderIds: () => [],
				getRegisteredProviderConfig: () => undefined,
			},
			getCurrentModel: () => current,
			createRuntime: async () => sidecar,
			onAttempt: (entry) => attempts.push(entry),
		});
		const result = await runtime.compact({
			preparation: {
				firstKeptEntryId: "kept",
				messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old history" }], timestamp: Date.now() }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 4_000,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 500 },
			},
			signal: new AbortController().signal,
		}, {
			...route,
			model: "current",
			fallbackModels: ["aux-dedupe/small", "aux-dedupe/fallback"],
			maxOutputTokens: 1_000,
		});
		assert.match(result.summary, /fallback summary/);
		assert.equal(faux.state.callCount, 2);
		assert.deepEqual(attempts.map((entry) => entry.status), ["error", "ok"]);
	});

	test("lets native compaction decide whether serialized input fits", async () => {
		const tiny = model("openai", "small");
		tiny.contextWindow = 100;
		const { runtime, attempts } = harness([], [tiny]);
		await assert.rejects(runtime.compact({
			preparation: {
				firstKeptEntryId: "kept",
				messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "x".repeat(10_000) }], timestamp: Date.now() }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 3_000,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 },
			},
			signal: new AbortController().signal,
		}, route), (error: unknown) => error instanceof AuxiliaryError && error.code === "provider_error");
		assert.equal(attempts[0]!.errorCode, "provider_error");
	});
});
