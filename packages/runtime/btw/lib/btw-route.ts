import { randomUUID } from "node:crypto";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";

import type { AuxiliaryBtwRoute } from "./config.ts";

export interface BtwCandidate {
	model: Model<Api>;
	thinking: ThinkingLevel;
	timeoutMs: number;
	maxOutputTokens: number;
	fallbackIndex: number;
	auxiliary: boolean;
}

export interface BtwUsageEntryV1 {
	version: 1;
	id: string;
	task: "btw";
	executor: "session";
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	status: "ok" | "error" | "aborted" | "timeout";
	fallbackIndex: number;
	startedAt: number;
	durationMs: number;
	scopeId: string;
	usage?: Usage;
	errorCode?: "auth_unavailable" | "timeout" | "aborted" | "provider_error" | "empty_response";
}

interface ResolveBtwCandidatesOptions {
	route?: AuxiliaryBtwRoute;
	current?: Model<Api>;
	legacyThinking: ThinkingLevel;
	legacyMaxOutputTokens: number;
	find: (provider: string, modelId: string) => Model<Api> | undefined;
}

function resolveRef(ref: string, current: Model<Api> | undefined, find: ResolveBtwCandidatesOptions["find"]): Model<Api> | undefined {
	if (ref === "current") return current;
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return find(ref.slice(0, slash), ref.slice(slash + 1));
}

export function createBtwUsageEntry(
	candidate: BtwCandidate,
	status: BtwUsageEntryV1["status"],
	startedAt: number,
	finishedAt: number,
	usage?: Usage,
	errorCode?: BtwUsageEntryV1["errorCode"],
	scopeId: string = randomUUID(),
): BtwUsageEntryV1 {
	return {
		version: 1,
		id: randomUUID(),
		task: "btw",
		executor: "session",
		provider: candidate.model.provider,
		model: candidate.model.id,
		thinking: candidate.thinking,
		status,
		fallbackIndex: candidate.fallbackIndex,
		startedAt,
		durationMs: Math.max(0, finishedAt - startedAt),
		scopeId,
		...(usage ? { usage } : {}),
		...(errorCode ? { errorCode } : {}),
	};
}

export function resolveBtwCandidates(options: ResolveBtwCandidatesOptions): BtwCandidate[] {
	if (!options.route) {
		if (!options.current || !options.current.input.includes("text")) return [];
		return [{
			model: options.current,
			thinking: options.legacyThinking,
			timeoutMs: 0,
			maxOutputTokens: Math.min(options.legacyMaxOutputTokens, options.current.maxTokens),
			fallbackIndex: 0,
			auxiliary: false,
		}];
	}

	const candidates: BtwCandidate[] = [];
	const seen = new Set<string>();
	for (const ref of [options.route.model, ...options.route.fallbackModels]) {
		const model = resolveRef(ref, options.current, options.find);
		if (!model || !model.input.includes("text")) continue;
		const key = `${model.provider}\u0000${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({
			model,
			thinking: model.reasoning ? options.route.thinking : "off",
			timeoutMs: options.route.timeoutMs,
			maxOutputTokens: Math.min(options.route.maxOutputTokens, model.maxTokens),
			fallbackIndex: candidates.length,
			auxiliary: true,
		});
	}
	return candidates;
}
