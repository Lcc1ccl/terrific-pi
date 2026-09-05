import { randomUUID } from "node:crypto";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	InMemoryCredentialStore,
	type Api,
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	compact as nativeCompact,
	ModelRuntime,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

type CompactionPreparation = Parameters<typeof nativeCompact>[0];
type CompactionResult = Awaited<ReturnType<typeof nativeCompact>>;
type RegisteredProviderConfig = ReturnType<ModelRegistry["getRegisteredProviderConfig"]>;

import { parseModelRef } from "./config.ts";
import { extractAssistantText } from "./prompts.ts";
import type {
	AuxiliaryCallRequest,
	AuxiliaryCallResult,
	AuxiliaryErrorCode,
	AuxiliaryRouteConfig,
	AuxiliaryUsageEntryV1,
} from "./types.ts";
import { ActiveTaskTracker } from "./usage.ts";

export class AuxiliaryError extends Error {
	readonly code: AuxiliaryErrorCode;
	readonly retryable: boolean;

	constructor(code: AuxiliaryErrorCode, message: string, retryable = false) {
		super(message);
		this.name = "AuxiliaryError";
		this.code = code;
		this.retryable = retryable;
	}
}

interface RegistryLike {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| { ok: true; apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> }
		| { ok: false; error: string }
	>;
	getRegisteredProviderIds(): readonly string[];
	getRegisteredProviderConfig(provider: string): RegisteredProviderConfig;
}

interface RuntimeLike {
	registerProvider(provider: string, config: NonNullable<RegisteredProviderConfig>): void;
	completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): ReturnType<ModelRuntime["streamSimple"]>;
}

interface AuxiliaryRuntimeOptions {
	registry: RegistryLike;
	getCurrentModel: () => Model<Api> | undefined;
	createRuntime?: () => Promise<RuntimeLike>;
	onAttempt?: (entry: AuxiliaryUsageEntryV1) => void;
	onActiveChange?: (status: string | undefined) => void;
}

export interface AuxiliaryCompactionRequest {
	preparation: CompactionPreparation;
	customInstructions?: string;
	signal: AbortSignal;
}

const FALLBACK_CODES = new Set<AuxiliaryErrorCode>([
	"model_not_found",
	"auth_unavailable",
	"unsupported_input",
	"input_too_large",
	"timeout",
	"provider_error",
	"empty_response",
]);

function intendedModel(ref: string, current: Model<Api> | undefined): { provider: string; model: string } {
	const parsed = parseModelRef(ref);
	if (parsed === "current") return { provider: current?.provider ?? "", model: current?.id ?? "current" };
	if (parsed) return { provider: parsed.provider, model: parsed.modelId };
	const slash = ref.indexOf("/");
	return { provider: slash > 0 ? ref.slice(0, slash) : "", model: slash > 0 ? ref.slice(slash + 1) : ref };
}

function modelIdentity(model: Model<Api>): string {
	return `${model.provider}\u0000${model.id}`;
}

function statusFor(code: AuxiliaryErrorCode): AuxiliaryUsageEntryV1["status"] {
	if (code === "aborted") return "aborted";
	if (code === "timeout") return "timeout";
	return "error";
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("Operation aborted"));
		void operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

function sumUsage(messages: readonly AssistantMessage[]): Usage | undefined {
	if (messages.length === 0) return undefined;
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let reasoning = 0;
	let hasReasoning = false;
	for (const message of messages) {
		const usage = message.usage;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
		if (typeof usage.reasoning === "number") {
			reasoning += usage.reasoning;
			hasReasoning = true;
		}
	}
	if (hasReasoning) total.reasoning = reasoning;
	return total;
}

export class AuxiliaryRuntime {
	private sidecar?: Promise<RuntimeLike>;
	private readonly lifecycle = new AbortController();
	private readonly active: ActiveTaskTracker;
	private readonly options: AuxiliaryRuntimeOptions;

	constructor(options: AuxiliaryRuntimeOptions) {
		this.options = options;
		this.active = new ActiveTaskTracker(options.onActiveChange ?? (() => {}));
	}

	private async getRuntime(signal: AbortSignal): Promise<RuntimeLike> {
		this.sidecar ??= (this.options.createRuntime
			? this.options.createRuntime()
			: ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				allowModelNetwork: false,
			}));
		const runtime = await raceWithSignal(this.sidecar, signal);
		for (const provider of this.options.registry.getRegisteredProviderIds()) {
			const config = this.options.registry.getRegisteredProviderConfig(provider);
			if (config) runtime.registerProvider(provider, config);
		}
		return runtime;
	}

	private resolveModel(ref: string, requiredInput: "text" | "image"): Model<Api> {
		const parsed = parseModelRef(ref);
		const selected = parsed === "current"
			? this.options.getCurrentModel()
			: parsed
				? this.options.registry.find(parsed.provider, parsed.modelId)
				: undefined;
		if (!selected) throw new AuxiliaryError("model_not_found", "Auxiliary model is not available", true);
		if (!selected.input.includes(requiredInput)) {
			throw new AuxiliaryError("unsupported_input", `Auxiliary model does not support ${requiredInput} input`, true);
		}
		return selected;
	}

	private record(entry: AuxiliaryUsageEntryV1, shouldRecord?: () => boolean): void {
		try {
			if (shouldRecord?.() === false) return;
			this.options.onAttempt?.(entry);
		} catch {
			// Usage reporting must not change task behavior.
		}
	}

	async call(request: AuxiliaryCallRequest, route: AuxiliaryRouteConfig): Promise<AuxiliaryCallResult> {
		const current = this.options.getCurrentModel();
		const label = intendedModel(route.model, current).model;
		const activeId = this.active.start(request.task, label);
		const candidates = [route.model, ...route.fallbackModels];
		const seenModels = new Set<string>();
		let lastError = new AuxiliaryError("model_not_found", "No auxiliary model was attempted");
		try {
			if (request.signal?.aborted || this.lifecycle.signal.aborted) {
				throw new AuxiliaryError("aborted", "Auxiliary call was aborted");
			}
			for (let fallbackIndex = 0; fallbackIndex < candidates.length; fallbackIndex++) {
				const ref = candidates[fallbackIndex]!;
				const intended = intendedModel(ref, current);
				const startedAt = Date.now();
				let selected: Model<Api> | undefined;
				let response: AssistantMessage | undefined;
				const timeoutSignal = AbortSignal.timeout(route.timeoutMs);
				const signals = [timeoutSignal, this.lifecycle.signal];
				if (request.signal) signals.push(request.signal);
				const signal = AbortSignal.any(signals);
				try {
					selected = this.resolveModel(ref, request.requiredInput);
					const selectedKey = modelIdentity(selected);
					if (seenModels.has(selectedKey)) continue;
					seenModels.add(selectedKey);
					const auth = await raceWithSignal(this.options.registry.getApiKeyAndHeaders(selected), signal);
					if (!auth.ok) throw new AuxiliaryError("auth_unavailable", "Auxiliary model authentication is unavailable", true);
					const runtime = await this.getRuntime(signal);
					const thinking: ThinkingLevel = selected.reasoning ? route.thinking : "off";
					const context: Context = {
						...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
						messages: request.messages as Message[],
					};
					response = await raceWithSignal(runtime.completeSimple(selected, context, {
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						...(thinking === "off" ? {} : { reasoning: thinking }),
						maxTokens: Math.min(request.maxOutputTokens ?? route.maxOutputTokens, route.maxOutputTokens, selected.maxTokens),
						maxRetries: route.maxRetries,
						maxRetryDelayMs: 10_000,
						timeoutMs: route.timeoutMs,
						signal,
					}), signal);
					if (response.stopReason === "error") throw new AuxiliaryError("provider_error", "Auxiliary provider returned an error", true);
					if (response.stopReason === "aborted") {
						if (request.signal?.aborted || this.lifecycle.signal.aborted) throw new AuxiliaryError("aborted", "Auxiliary call was aborted");
						if (timeoutSignal.aborted) throw new AuxiliaryError("timeout", "Auxiliary call timed out", true);
						throw new AuxiliaryError("aborted", "Auxiliary call was aborted");
					}
					if (response.stopReason === "length") throw new AuxiliaryError("invalid_output", "Auxiliary output was truncated");
					const extracted = extractAssistantText(response.content);
					if (!extracted) throw new AuxiliaryError("empty_response", "Auxiliary response contained no text", true);
					let text = extracted;
					if (request.validateOutput) {
						try {
							text = request.validateOutput(extracted, response);
						} catch (error) {
							if (error instanceof AuxiliaryError) throw error;
							throw new AuxiliaryError("invalid_output", "Auxiliary output failed validation");
						}
					}
					const durationMs = Date.now() - startedAt;
					const provider = response.provider || selected.provider;
					const model = response.model || selected.id;
					this.record({
						version: 1,
						id: randomUUID(),
						task: request.task,
						executor: request.executor,
						provider,
						model,
						thinking,
						status: "ok",
						fallbackIndex,
						startedAt,
						durationMs,
						...(request.scopeId ? { scopeId: request.scopeId } : {}),
						usage: response.usage,
					}, request.shouldRecordAttempt);
					return { status: "ok", text, provider, model, thinking, fallbackIndex, durationMs, usage: response.usage, stopReason: response.stopReason };
				} catch (error) {
					let failure: AuxiliaryError;
					if (error instanceof AuxiliaryError) failure = error;
					else if (request.signal?.aborted || this.lifecycle.signal.aborted) failure = new AuxiliaryError("aborted", "Auxiliary call was aborted");
					else if (timeoutSignal?.aborted) failure = new AuxiliaryError("timeout", "Auxiliary call timed out", true);
					else failure = new AuxiliaryError("provider_error", "Auxiliary provider request failed", true);
					lastError = failure;
					const thinking: ThinkingLevel = selected?.reasoning ? route.thinking : "off";
					this.record({
						version: 1,
						id: randomUUID(),
						task: request.task,
						executor: request.executor,
						provider: response?.provider || selected?.provider || intended.provider,
						model: response?.model || selected?.id || intended.model,
						thinking,
						status: statusFor(failure.code),
						fallbackIndex,
						startedAt,
						durationMs: Date.now() - startedAt,
						...(request.scopeId ? { scopeId: request.scopeId } : {}),
						...(response?.usage ? { usage: response.usage } : {}),
						errorCode: failure.code,
					}, request.shouldRecordAttempt);
					if (!FALLBACK_CODES.has(failure.code) || fallbackIndex === candidates.length - 1) throw failure;
				}
			}
			throw lastError;
		} finally {
			this.active.finish(activeId);
		}
	}

	async compact(request: AuxiliaryCompactionRequest, route: AuxiliaryRouteConfig): Promise<CompactionResult> {
		const current = this.options.getCurrentModel();
		const activeId = this.active.start("compression", intendedModel(route.model, current).model);
		const candidates = [route.model, ...route.fallbackModels];
		const seenModels = new Set<string>();
		let lastError = new AuxiliaryError("model_not_found", "No compression model was attempted");
		try {
			for (let fallbackIndex = 0; fallbackIndex < candidates.length; fallbackIndex++) {
				const ref = candidates[fallbackIndex]!;
				const startedAt = Date.now();
				const intended = intendedModel(ref, current);
				let selected: Model<Api> | undefined;
				const timeoutSignal = AbortSignal.timeout(route.timeoutMs);
				const signal = AbortSignal.any([request.signal, this.lifecycle.signal, timeoutSignal]);
				try {
					if (request.signal.aborted || this.lifecycle.signal.aborted) throw new AuxiliaryError("aborted", "Compaction was aborted");
					selected = this.resolveModel(ref, "text");
					const selectedKey = modelIdentity(selected);
					if (seenModels.has(selectedKey)) continue;
					seenModels.add(selectedKey);
					const auth = await raceWithSignal(this.options.registry.getApiKeyAndHeaders(selected), signal);
					if (!auth.ok) throw new AuxiliaryError("auth_unavailable", "Compression model authentication is unavailable", true);
					const runtime = await this.getRuntime(signal);
					const captures: Array<Promise<AssistantMessage | undefined>> = [];
					const stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
						const result = runtime.streamSimple(model, context, options);
						captures.push(result.result().catch(() => undefined));
						return result;
					};
					const thinking: ThinkingLevel = selected.reasoning ? route.thinking : "off";
					const result = await raceWithSignal(nativeCompact(
						request.preparation,
						{ ...selected, maxTokens: Math.min(selected.maxTokens, route.maxOutputTokens) },
						auth.apiKey,
						// compact() still declares string-only headers but forwards ProviderHeaders unchanged.
						auth.headers as Record<string, string> | undefined,
						request.customInstructions,
						signal,
						thinking,
						stream,
						auth.env,
					), signal);
					const responses = (await raceWithSignal(Promise.all(captures), signal)).filter((value): value is AssistantMessage => value !== undefined);
					const usage = sumUsage(responses);
					const durationMs = Date.now() - startedAt;
					this.record({
						version: 1,
						id: randomUUID(),
						task: "compression",
						executor: "call",
						provider: responses.at(-1)?.provider || selected.provider,
						model: responses.at(-1)?.model || selected.id,
						thinking,
						status: "ok",
						fallbackIndex,
						startedAt,
						durationMs,
						...(usage ? { usage } : {}),
					});
					return result;
				} catch (error) {
					let failure: AuxiliaryError;
					if (error instanceof AuxiliaryError) failure = error;
					else if (request.signal.aborted || this.lifecycle.signal.aborted) failure = new AuxiliaryError("aborted", "Compaction was aborted");
					else if (timeoutSignal?.aborted) failure = new AuxiliaryError("timeout", "Auxiliary compaction timed out", true);
					else failure = new AuxiliaryError("provider_error", "Auxiliary compaction failed", true);
					lastError = failure;
					this.record({
						version: 1,
						id: randomUUID(),
						task: "compression",
						executor: "call",
						provider: selected?.provider || intended.provider,
						model: selected?.id || intended.model,
						thinking: selected?.reasoning ? route.thinking : "off",
						status: statusFor(failure.code),
						fallbackIndex,
						startedAt,
						durationMs: Date.now() - startedAt,
						errorCode: failure.code,
					});
					if (!FALLBACK_CODES.has(failure.code) || fallbackIndex === candidates.length - 1) throw failure;
				}
			}
			throw lastError;
		} finally {
			this.active.finish(activeId);
		}
	}

	shutdown(): void {
		this.lifecycle.abort();
		this.active.clear();
	}
}
