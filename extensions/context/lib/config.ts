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
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ModeName = "ask" | "plan" | "edit" | "auto";

export interface TerrificConfig {
	context: { topEntries: number };
	mode: { default: ModeName; persistPerSession: boolean };
	btw: {
		thinking: "minimal" | "low" | "medium" | "high";
		maxContextTokens: number;
		maxOutputTokens: number;
	};
}

export const DEFAULT_CONFIG: TerrificConfig = {
	context: { topEntries: 10 },
	mode: { default: "edit", persistPerSession: true },
	btw: {
		thinking: "minimal",
		maxContextTokens: 80_000,
		maxOutputTokens: 2000,
	},
};

const MODE_SET = new Set<ModeName>(["ask", "plan", "edit", "auto"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPositiveInt(value: unknown, fallback: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const n = Math.floor(value);
	return n > 0 ? Math.min(n, maximum) : fallback;
}

function asMode(value: unknown, fallback: ModeName): ModeName {
	return typeof value === "string" && MODE_SET.has(value as ModeName) ? (value as ModeName) : fallback;
}

function asThinking(
	value: unknown,
	fallback: TerrificConfig["btw"]["thinking"],
): TerrificConfig["btw"]["thinking"] {
	if (value === "minimal" || value === "low" || value === "medium" || value === "high") return value;
	return fallback;
}

export function mergeConfig(raw: unknown, base: TerrificConfig = DEFAULT_CONFIG): TerrificConfig {
	if (!isRecord(raw)) {
		return {
			context: { ...base.context },
			mode: { ...base.mode },
			btw: { ...base.btw },
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

export const TERRIFIC_CONFIG_BASENAME = "terrific.json";

export function resolveConfigPath(dir: string): string {
	return join(dir, TERRIFIC_CONFIG_BASENAME);
}

export function resolveConfigPaths(
	cwd = process.cwd(),
	agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	projectTrusted = false,
	configDirName = ".pi",
): string[] {
	const paths = [resolveConfigPath(agentDir)];
	if (projectTrusted) paths.push(resolveConfigPath(join(cwd, configDirName)));
	return paths;
}

export interface LoadConfigResult {
	config: TerrificConfig;
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

	for (const path of resolveConfigPaths(cwd, agentDir, projectTrusted, configDirName)) {
		const result = readJsonFile(path);
		if (!result.ok) {
			warnings.push(`terrific-config: failed to read ${path}: ${result.error}`);
			continue;
		}
		if (result.value !== undefined) {
			config = mergeConfig(result.value, config);
		}
	}

	return { config, warnings };
}

export type ContextConfigWriteResult = { ok: true; path: string } | { ok: false; path: string; error: string };

/** Atomically mutate only the context section at a selected global or trusted-project path. */
export function updateContextConfig(
	path: string,
	mutate: (context: Record<string, unknown>) => void,
): ContextConfigWriteResult {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	} catch (error) {
		return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
	}
	const lockPath = `${path}.lock`;
	try {
		const descriptor = openSync(lockPath, "wx", 0o600);
		closeSync(descriptor);
	} catch (error) {
		return { ok: false, path, error: `Failed to lock ${TERRIFIC_CONFIG_BASENAME}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const temporary = join(dirname(path), `.${TERRIFIC_CONFIG_BASENAME}.${process.pid}.${randomUUID()}.tmp`);
	try {
		let root: Record<string, unknown> = {};
		if (existsSync(path)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(path, "utf8"));
			} catch (error) {
				return { ok: false, path, error: `Failed to parse ${TERRIFIC_CONFIG_BASENAME}: ${error instanceof Error ? error.message : String(error)}` };
			}
			if (!isRecord(parsed)) return { ok: false, path, error: `${TERRIFIC_CONFIG_BASENAME} root must be an object` };
			root = parsed;
		}
		if (Object.hasOwn(root, "context") && !isRecord(root.context)) {
			return { ok: false, path, error: "context must be a JSON object" };
		}
		const context = isRecord(root.context) ? root.context : {};
		mutate(context);
		if (Object.keys(context).length === 0) delete root.context;
		else root.context = context;
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(root, null, 2)}\n`, "utf8");
			chmodSync(temporary, existsSync(path) ? statSync(path).mode & 0o777 : 0o600);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
		return { ok: true, path };
	} catch (error) {
		return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
	} finally {
		try {
			unlinkSync(temporary);
		} catch {}
		try {
			unlinkSync(lockPath);
		} catch {}
	}
}
