import type { AuxiliaryUsageEntryV1 } from "./types.ts";

export const AUXILIARY_USAGE_ENTRY_TYPE = "terrific-pi:auxiliary-usage-v1";
export const AUXILIARY_USAGE_INGEST_EVENT = "terrific-pi:auxiliary-usage:ingest-v1";
export const AUXILIARY_USAGE_CHANGED_EVENT = "terrific-pi:auxiliary-usage:changed-v1";
export const AUXILIARY_USAGE_SCOPE_SETTLED_EVENT = "terrific-pi:auxiliary-usage:scope-settled-v1";

const ENTRY_KEYS = new Set([
	"version", "id", "task", "executor", "provider", "model", "thinking", "status", "fallbackIndex",
	"startedAt", "durationMs", "scopeId", "usage", "errorCode",
]);
const EXECUTORS = new Set(["call", "session", "delegation"]);
const STATUSES = new Set(["ok", "error", "aborted", "timeout"]);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return finite(value.input) && finite(value.output) && finite(value.cacheRead) && finite(value.cacheWrite) && finite(value.totalTokens)
		&& (value.cost === undefined || (isRecord(value.cost) && finite(value.cost.total)));
}

export function isAuxiliaryUsageEntry(value: unknown): value is AuxiliaryUsageEntryV1 {
	if (!isRecord(value) || Object.keys(value).some((key) => !ENTRY_KEYS.has(key))) return false;
	return value.version === 1
		&& typeof value.id === "string" && value.id.length > 0
		&& typeof value.task === "string" && value.task.length > 0
		&& typeof value.executor === "string" && EXECUTORS.has(value.executor)
		&& typeof value.provider === "string"
		&& typeof value.model === "string"
		&& typeof value.thinking === "string" && THINKING.has(value.thinking)
		&& typeof value.status === "string" && STATUSES.has(value.status)
		&& Number.isInteger(value.fallbackIndex) && (value.fallbackIndex as number) >= 0
		&& finite(value.startedAt)
		&& finite(value.durationMs)
		&& (value.scopeId === undefined || (typeof value.scopeId === "string" && value.scopeId.length > 0 && value.scopeId.length <= 128))
		&& (value.usage === undefined || isUsage(value.usage))
		&& (value.errorCode === undefined || typeof value.errorCode === "string");
}

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface AuxiliaryUsageTotals {
	calls: number;
	tokens: number;
	cost: number;
	hasUnknownCost: boolean;
}

export function aggregateAuxiliaryUsage(entries: readonly BranchEntry[]): AuxiliaryUsageTotals {
	let calls = 0;
	let tokens = 0;
	let cost = 0;
	let hasUnknownCost = false;
	const seen = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== AUXILIARY_USAGE_ENTRY_TYPE || !isAuxiliaryUsageEntry(entry.data)) continue;
		if (seen.has(entry.data.id)) continue;
		seen.add(entry.data.id);
		calls += 1;
		tokens += entry.data.usage?.totalTokens ?? 0;
		const total = entry.data.usage?.cost?.total;
		if (typeof total === "number" && Number.isFinite(total)) cost += total;
		else hasUnknownCost = true;
	}
	return { calls, tokens, cost, hasUnknownCost };
}

export class ActiveTaskTracker {
	private readonly active = new Map<number, { task: string; model: string }>();
	private readonly update: (status: string | undefined) => void;
	private sequence = 0;

	constructor(update: (status: string | undefined) => void) {
		this.update = update;
	}

	start(task: string, model: string): number {
		const id = ++this.sequence;
		this.active.set(id, { task, model });
		this.render();
		return id;
	}

	finish(id: number): void {
		this.active.delete(id);
		this.render();
	}

	clear(): void {
		this.active.clear();
		this.render();
	}

	private render(): void {
		if (this.active.size === 0) {
			this.update(undefined);
			return;
		}
		if (this.active.size > 1) {
			this.update(`aux ${this.active.size} tasks`);
			return;
		}
		const value = this.active.values().next().value as { task: string; model: string };
		this.update(`aux ${value.task} · ${value.model}`);
	}
}
