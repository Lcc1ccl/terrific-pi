import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type ModeName = "ask" | "plan" | "edit" | "auto";

export interface AuxiliaryBtwRoute {
	model: string;
	thinking: ThinkingLevel;
	timeoutMs: number;
	maxOutputTokens: number;
	fallbackModels: string[];
}

export interface EssentialsConfig {
	context: { topEntries: number };
	mode: { default: ModeName; persistPerSession: boolean };
	btw: {
		thinking: "minimal" | "low" | "medium" | "high";
		maxContextTokens: number;
		maxOutputTokens: number;
	};
	auxiliaryBtw?: AuxiliaryBtwRoute;
}

export const DEFAULT_CONFIG: EssentialsConfig = {
	context: { topEntries: 10 },
	mode: { default: "edit", persistPerSession: true },
	btw: {
		thinking: "minimal",
		maxContextTokens: 80_000,
		maxOutputTokens: 2000,
	},
};

const MODE_SET = new Set<ModeName>(["ask", "plan", "edit", "auto"]);
const THINKING_SET = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPositiveInt(value: unknown, fallback: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const n = Math.floor(value);
	return n > 0 ? Math.min(n, maximum) : fallback;
}

function clampInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function parseModelRef(value: unknown): string | undefined {
	if (value === "current") return value;
	if (typeof value !== "string") return undefined;
	const ref = value.trim();
	const slash = ref.indexOf("/");
	return slash > 0 && slash < ref.length - 1 ? ref : undefined;
}

function parseAuxiliaryBtw(raw: Record<string, unknown>): AuxiliaryBtwRoute | undefined {
	if (!Object.hasOwn(raw, "auxiliary")) return undefined;
	const auxiliary = isRecord(raw.auxiliary) ? raw.auxiliary : {};
	if (auxiliary.enabled === false) return undefined;
	const defaults = isRecord(auxiliary.default) ? auxiliary.default : {};
	const tasks = isRecord(auxiliary.tasks) ? auxiliary.tasks : {};
	const task = isRecord(tasks.btw) ? tasks.btw : {};
	const model = parseModelRef(task.model) ?? parseModelRef(defaults.model) ?? "openai/gpt-5.4-mini";
	const thinkingValue = task.thinking ?? defaults.thinking ?? "low";
	const thinking = typeof thinkingValue === "string" && THINKING_SET.has(thinkingValue as ThinkingLevel)
		? thinkingValue as ThinkingLevel
		: "low";
	const rawFallbacks = Array.isArray(task.fallbackModels)
		? task.fallbackModels
		: Array.isArray(defaults.fallbackModels) ? defaults.fallbackModels : [];
	const seen = new Set([model]);
	const fallbacks: string[] = [];
	for (const value of rawFallbacks) {
		const ref = parseModelRef(value);
		if (!ref || seen.has(ref)) continue;
		seen.add(ref);
		fallbacks.push(ref);
		if (fallbacks.length === 3) break;
	}
	return {
		model,
		thinking,
		timeoutMs: clampInt(task.timeoutMs ?? defaults.timeoutMs, 60_000, 1_000, 600_000),
		maxOutputTokens: clampInt(task.maxOutputTokens ?? defaults.maxOutputTokens, 2_000, 16, 128_000),
		fallbackModels: fallbacks,
	};
}

function cloneAuxiliaryBtw(value: AuxiliaryBtwRoute | undefined): AuxiliaryBtwRoute | undefined {
	return value ? { ...value, fallbackModels: [...value.fallbackModels] } : undefined;
}

function asMode(value: unknown, fallback: ModeName): ModeName {
	return typeof value === "string" && MODE_SET.has(value as ModeName) ? (value as ModeName) : fallback;
}

function asThinking(
	value: unknown,
	fallback: EssentialsConfig["btw"]["thinking"],
): EssentialsConfig["btw"]["thinking"] {
	if (value === "minimal" || value === "low" || value === "medium" || value === "high") return value;
	return fallback;
}

export function mergeConfig(raw: unknown, base: EssentialsConfig = DEFAULT_CONFIG): EssentialsConfig {
	if (!isRecord(raw)) {
		return {
			context: { ...base.context },
			mode: { ...base.mode },
			btw: { ...base.btw },
			...(base.auxiliaryBtw ? { auxiliaryBtw: cloneAuxiliaryBtw(base.auxiliaryBtw) } : {}),
		};
	}

	const context = isRecord(raw.context) ? raw.context : {};
	const mode = isRecord(raw.mode) ? raw.mode : {};
	const btw = isRecord(raw.btw) ? raw.btw : {};

	return {
		context: {
			topEntries: asPositiveInt(context.topEntries, base.context.topEntries, 100),
		},
		mode: {
			default: asMode(mode.default, base.mode.default),
			persistPerSession:
				typeof mode.persistPerSession === "boolean" ? mode.persistPerSession : base.mode.persistPerSession,
		},
		btw: {
			thinking: asThinking(btw.thinking, base.btw.thinking),
			maxContextTokens: asPositiveInt(btw.maxContextTokens, base.btw.maxContextTokens, 1_000_000),
			maxOutputTokens: asPositiveInt(btw.maxOutputTokens, base.btw.maxOutputTokens, 100_000),
		},
		...(Object.hasOwn(raw, "auxiliary")
			? { auxiliaryBtw: parseAuxiliaryBtw(raw) }
			: base.auxiliaryBtw ? { auxiliaryBtw: cloneAuxiliaryBtw(base.auxiliaryBtw) } : {}),
	};
}

function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		if (!existsSync(path)) return { ok: true, value: undefined };
		return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function resolveConfigPaths(
	cwd = process.cwd(),
	agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	projectTrusted = false,
	configDirName = ".pi",
): string[] {
	const paths = [join(agentDir, "pi-essentials.json")];
	if (projectTrusted) paths.push(join(cwd, configDirName, "pi-essentials.json"));
	return paths;
}

export interface LoadConfigResult {
	config: EssentialsConfig;
	warnings: string[];
}

/** Load global then project config. Failures never throw. */
export function loadConfig(
	cwd = process.cwd(),
	agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	projectTrusted = false,
	configDirName = ".pi",
): LoadConfigResult {
	const warnings: string[] = [];
	let config = mergeConfig({});

	for (const [index, path] of resolveConfigPaths(cwd, agentDir, projectTrusted, configDirName).entries()) {
		const result = readJsonFile(path);
		if (!result.ok) {
			warnings.push(`pi-essentials: failed to read ${path}: ${result.error}`);
			continue;
		}
		if (result.value !== undefined) {
			const globalAuxiliary = config.auxiliaryBtw;
			config = mergeConfig(result.value, config);
			if (index > 0) {
				delete config.auxiliaryBtw;
				if (globalAuxiliary) config.auxiliaryBtw = globalAuxiliary;
			}
		}
	}

	return { config, warnings };
}
