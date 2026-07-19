import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { TokenTotals } from "./types.ts";

export interface SessionUsageTotals {
	tokens: TokenTotals;
	cost: number;
}

type BranchEntry = {
	type: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
	};
};

export interface AuxiliaryUsageTotals {
	calls: number;
	tokens: number;
	cost?: number;
	hasUnknownUsage?: boolean;
}

const AUXILIARY_USAGE_ENTRY_TYPE = "terrific-pi:auxiliary-usage-v1";
const AUXILIARY_KEYS = new Set([
	"version", "id", "task", "executor", "provider", "model", "thinking", "status", "fallbackIndex",
	"startedAt", "durationMs", "usage", "errorCode",
]);
const AUXILIARY_EXECUTORS = new Set(["call", "session", "delegation"]);
const AUXILIARY_STATUSES = new Set(["ok", "error", "aborted", "timeout"]);
const AUXILIARY_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function canonicalAuxiliaryUsage(value: unknown): value is Record<string, unknown> & {
	id: string;
	usage?: { totalTokens: number; cost?: { total: number } };
} {
	if (!isRecord(value) || Object.keys(value).some((key) => !AUXILIARY_KEYS.has(key))) return false;
	const usage = value.usage;
	return value.version === 1
		&& typeof value.id === "string" && value.id.length > 0
		&& typeof value.task === "string" && value.task.length > 0
		&& typeof value.executor === "string" && AUXILIARY_EXECUTORS.has(value.executor)
		&& typeof value.provider === "string"
		&& typeof value.model === "string"
		&& typeof value.thinking === "string" && AUXILIARY_THINKING.has(value.thinking)
		&& typeof value.status === "string" && AUXILIARY_STATUSES.has(value.status)
		&& Number.isInteger(value.fallbackIndex) && (value.fallbackIndex as number) >= 0
		&& finite(value.startedAt)
		&& finite(value.durationMs)
		&& (usage === undefined || (isRecord(usage)
			&& finite(usage.input) && finite(usage.output) && finite(usage.cacheRead) && finite(usage.cacheWrite) && finite(usage.totalTokens)
			&& (usage.cost === undefined || (isRecord(usage.cost) && finite(usage.cost.total)))))
		&& (value.errorCode === undefined || typeof value.errorCode === "string");
}

export function aggregateAuxiliaryUsage(entries: readonly BranchEntry[]): AuxiliaryUsageTotals {
	let calls = 0;
	let tokens = 0;
	let cost = 0;
	let allCostsKnown = true;
	let hasUnknownUsage = false;
	const seen = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== AUXILIARY_USAGE_ENTRY_TYPE || !canonicalAuxiliaryUsage(entry.data)) continue;
		if (seen.has(entry.data.id)) continue;
		seen.add(entry.data.id);
		calls += 1;
		tokens += entry.data.usage?.totalTokens ?? 0;
		if (!entry.data.usage) hasUnknownUsage = true;
		const total = entry.data.usage?.cost?.total;
		if (typeof total === "number") cost += total;
		else allCostsKnown = false;
	}
	return { calls, tokens, ...(allCostsKnown ? { cost } : {}), ...(hasUnknownUsage ? { hasUnknownUsage: true } : {}) };
}

export function aggregateSessionUsage(entries: readonly BranchEntry[]): SessionUsageTotals {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = (entry.message as AssistantMessage).usage;
		if (!usage) continue;
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		cacheRead += usage.cacheRead ?? 0;
		cacheWrite += usage.cacheWrite ?? 0;
		cost += usage.cost?.total ?? 0;
	}

	return {
		tokens: { input, output, cacheRead, cacheWrite },
		cost,
	};
}
