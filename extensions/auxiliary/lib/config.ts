import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { AuxiliaryConfig, AuxiliaryRouteConfig, AuxiliaryTaskKey } from "./types.ts";

const DEFAULT_ROUTE: AuxiliaryRouteConfig = {
	model: "openai/gpt-5.4-mini",
	thinking: "off",
	timeoutMs: 60_000,
	maxOutputTokens: 2_048,
	maxRetries: 1,
	fallbackModels: [],
};

export const DEFAULT_AUXILIARY_CONFIG: AuxiliaryConfig = {
	enabled: true,
	default: DEFAULT_ROUTE,
	tasks: {
		compression: { thinking: "low", timeoutMs: 120_000, maxOutputTokens: 12_000, maxRetries: 0 },
		title_generation: { timeoutMs: 30_000, maxOutputTokens: 96 },
		text_summary: { maxOutputTokens: 3_000, fallbackModels: ["openai/gpt-5.6-luna"] },
		commit_message: { timeoutMs: 30_000, maxOutputTokens: 256 },
		btw: { thinking: "low", maxOutputTokens: 2_000 },
		web_research: {
			model: "openai/gpt-5.6-luna",
			thinking: "low",
			timeoutMs: 300_000,
			fallbackModels: ["openai/gpt-5.4-mini"],
		},
	},
	git: { confirm: true, allowHeadless: false, allowPush: true },
};

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FORBIDDEN_ROUTE_KEYS = ["apiKey", "baseUrl", "headers"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfig(config: AuxiliaryConfig): AuxiliaryConfig {
	return {
		enabled: config.enabled,
		default: { ...config.default, fallbackModels: [...config.default.fallbackModels] },
		tasks: Object.fromEntries(Object.entries(config.tasks).map(([key, route]) => [key, {
			...route,
			...(route.fallbackModels ? { fallbackModels: [...route.fallbackModels] } : {}),
		}])),
		git: { ...config.git },
	};
}

function clampInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function thinking(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel) ? value as ThinkingLevel : fallback;
}

function modelRef(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function fallbackModels(value: unknown, fallback: readonly string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	return value.filter((item): item is string => typeof item === "string" && parseModelRef(item) !== undefined);
}

function mergeRoute(raw: unknown, base: AuxiliaryRouteConfig): AuxiliaryRouteConfig {
	if (!isRecord(raw)) return { ...base, fallbackModels: [...base.fallbackModels] };
	return {
		model: modelRef(raw.model, base.model),
		thinking: thinking(raw.thinking, base.thinking),
		timeoutMs: clampInt(raw.timeoutMs, base.timeoutMs, 1_000, 600_000),
		maxOutputTokens: clampInt(raw.maxOutputTokens, base.maxOutputTokens, 16, 128_000),
		maxRetries: clampInt(raw.maxRetries, base.maxRetries, 0, 2),
		fallbackModels: fallbackModels(raw.fallbackModels, base.fallbackModels),
	};
}

function collectForbiddenWarnings(value: unknown, location: string, warnings: string[]): void {
	if (!isRecord(value)) return;
	for (const key of FORBIDDEN_ROUTE_KEYS) {
		if (Object.hasOwn(value, key)) warnings.push(`auxiliary: ignored forbidden ${location}.${key}`);
	}
}

export function parseModelRef(value: string): { provider: string; modelId: string } | "current" | undefined {
	const trimmed = value.trim();
	if (trimmed === "current") return "current";
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

export interface MergeAuxiliaryConfigResult {
	config: AuxiliaryConfig;
	warnings: string[];
}

export function mergeAuxiliaryConfig(raw: unknown): MergeAuxiliaryConfigResult {
	const warnings: string[] = [];
	const root = isRecord(raw) && isRecord(raw.auxiliary) ? raw.auxiliary : {};
	collectForbiddenWarnings(root, "config", warnings);
	collectForbiddenWarnings(root.default, "default", warnings);

	const config = cloneConfig(DEFAULT_AUXILIARY_CONFIG);
	config.enabled = typeof root.enabled === "boolean" ? root.enabled : config.enabled;
	config.default = mergeRoute(root.default, config.default);

	if (isRecord(root.tasks)) {
		for (const [key, value] of Object.entries(root.tasks)) {
			collectForbiddenWarnings(value, `tasks.${key}`, warnings);
			const base = resolveTaskRoute(config, key);
			config.tasks[key] = mergeRoute(value, base);
		}
	}
	if (isRecord(root.git)) {
		config.git = {
			confirm: typeof root.git.confirm === "boolean" ? root.git.confirm : config.git.confirm,
			allowHeadless: typeof root.git.allowHeadless === "boolean" ? root.git.allowHeadless : config.git.allowHeadless,
			allowPush: typeof root.git.allowPush === "boolean" ? root.git.allowPush : config.git.allowPush,
		};
	}
	return { config, warnings };
}

export function resolveTaskRoute(config: AuxiliaryConfig, task: AuxiliaryTaskKey | string): AuxiliaryRouteConfig {
	const override = config.tasks[task] ?? {};
	const merged = mergeRoute(override, config.default);
	const seen = new Set<string>([merged.model]);
	merged.fallbackModels = merged.fallbackModels.filter((ref) => {
		if (seen.has(ref)) return false;
		seen.add(ref);
		return true;
	}).slice(0, 3);
	return merged;
}

export function resolveAuxiliaryConfigPath(agentDir: string): string {
	return join(agentDir, "pi-essentials.json");
}

export function loadAuxiliaryConfig(agentDir: string): MergeAuxiliaryConfigResult {
	const path = resolveAuxiliaryConfigPath(agentDir);
	if (!existsSync(path)) return { config: cloneConfig(DEFAULT_AUXILIARY_CONFIG), warnings: [] };
	try {
		return mergeAuxiliaryConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
	} catch (error) {
		return {
			config: cloneConfig(DEFAULT_AUXILIARY_CONFIG),
			warnings: [`auxiliary: failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}
