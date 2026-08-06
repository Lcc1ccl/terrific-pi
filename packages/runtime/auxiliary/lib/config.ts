import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type {
	AuxiliaryConfig,
	AuxiliaryRouteConfig,
	AuxiliaryTaskKey,
	AuxiliaryTaskRouteConfig,
} from "./types.ts";

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
		commit_message: { thinking: "off", timeoutMs: 30_000, maxOutputTokens: 256 },
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

function mergeTaskRoute(
	raw: unknown,
	base: AuxiliaryRouteConfig,
	previous: AuxiliaryTaskRouteConfig,
): AuxiliaryTaskRouteConfig {
	const route = mergeRoute(raw, base);
	const useAuxiliary = isRecord(raw) && typeof raw.useAuxiliary === "boolean"
		? raw.useAuxiliary
		: previous.useAuxiliary;
	return {
		...route,
		...(useAuxiliary === undefined ? {} : { useAuxiliary }),
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
			const previous = config.tasks[key] ?? {};
			const base = mergeRoute(previous, config.default);
			config.tasks[key] = mergeTaskRoute(value, base, previous);
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
	if (override.useAuxiliary === false) {
		merged.model = "current";
		merged.fallbackModels = [];
		return merged;
	}
	const seen = new Set<string>([merged.model]);
	merged.fallbackModels = merged.fallbackModels.filter((ref) => {
		if (seen.has(ref)) return false;
		seen.add(ref);
		return true;
	}).slice(0, 3);
	return merged;
}

export const TERRIFIC_CONFIG_BASENAME = "terrific.json";

export function resolveConfigPath(agentDir: string): string {
	return join(agentDir, TERRIFIC_CONFIG_BASENAME);
}

/** @deprecated use resolveConfigPath */
export function resolveAuxiliaryConfigPath(agentDir: string): string {
	return resolveConfigPath(agentDir);
}

type AuxiliaryConfigDocumentResult =
	| { ok: true; root: Record<string, unknown>; auxiliary: Record<string, unknown> }
	| { ok: false; error: string };

function readAuxiliaryConfigDocument(path: string): AuxiliaryConfigDocumentResult {
	if (!existsSync(path)) return { ok: true, root: {}, auxiliary: {} };
	try {
		const root: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(root)) throw new Error("Config root must be a JSON object");
		if (!Object.hasOwn(root, "auxiliary")) return { ok: true, root, auxiliary: {} };
		if (!isRecord(root.auxiliary)) throw new Error("auxiliary must be a JSON object");
		return { ok: true, root, auxiliary: root.auxiliary };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export type AuxiliaryConfigSourceResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; error: string };

export function readAuxiliaryConfigSource(agentDir: string): AuxiliaryConfigSourceResult {
	const path = resolveConfigPath(agentDir);
	const document = readAuxiliaryConfigDocument(path);
	return document.ok
		? { ok: true, value: document.auxiliary }
		: { ok: false, error: `auxiliary: failed to read ${path}: ${document.error}` };
}

export type UpdateAuxiliaryConfigResult = { ok: true } | { ok: false; error: string };

type ConfigLockResult =
	| { ok: true; path: string; token: string }
	| { ok: false; error: string };

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function acquireConfigLock(path: string): ConfigLockResult {
	const lockPath = `${path}.lock`;
	const token = randomUUID();
	let created = false;
	try {
		const descriptor = openSync(lockPath, "wx", 0o600);
		created = true;
		try {
			writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }), "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		return { ok: true, path: lockPath, token };
	} catch (error) {
		if (created) {
			try {
				unlinkSync(lockPath);
			} catch {}
		}
		if (errorCode(error) === "EEXIST") {
			return {
				ok: false,
				error: `another process may be updating the config; remove ${lockPath} only after confirming it is stale`,
			};
		}
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function releaseConfigLock(lock: Extract<ConfigLockResult, { ok: true }>): void {
	try {
		const value: unknown = JSON.parse(readFileSync(lock.path, "utf8"));
		if (isRecord(value) && value.token === lock.token) unlinkSync(lock.path);
	} catch {}
}

function syncDirectory(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		fsyncSync(descriptor);
	} catch (error) {
		if (!["EINVAL", "EPERM", "EISDIR"].includes(errorCode(error) ?? "")) throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function writeConfigAtomically(path: string, temporary: string, content: string, mode: number): void {
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(descriptor, content, "utf8");
		chmodSync(temporary, mode);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, path);
	syncDirectory(dirname(path));
}

export function updateAuxiliaryConfig(
	agentDir: string,
	mutate: (auxiliary: Record<string, unknown>) => void,
): UpdateAuxiliaryConfigResult {
	const path = resolveConfigPath(agentDir);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	} catch (error) {
		return {
			ok: false,
			error: `auxiliary: failed to update ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const lock = acquireConfigLock(path);
	if (!lock.ok) return { ok: false, error: `auxiliary: failed to update ${path}: ${lock.error}` };

	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const document = readAuxiliaryConfigDocument(path);
		if (!document.ok) return { ok: false, error: `auxiliary: failed to update ${path}: ${document.error}` };
		mutate(document.auxiliary);
		document.root.auxiliary = document.auxiliary;
		const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
		writeConfigAtomically(path, temporary, `${JSON.stringify(document.root, null, 2)}\n`, mode);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: `auxiliary: failed to update ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		try {
			unlinkSync(temporary);
		} catch {}
		releaseConfigLock(lock);
	}
}

export function loadAuxiliaryConfig(agentDir: string): MergeAuxiliaryConfigResult {
	const path = resolveConfigPath(agentDir);
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
