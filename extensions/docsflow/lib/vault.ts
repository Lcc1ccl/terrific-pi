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
import path from "node:path";

import type { DocsStage } from "./state.ts";

/** Optional Obsidian vault defaults (only used when vaultEnabled=true). */
export const DEFAULT_VAULT_ROOT = "/mnt/g/Mindriver";
export const DEFAULT_PROJECT_BASE = "2_Career/01-INDIE/开发";
export const DOCSFLOW_DIRNAME = "docsflow";

export type DocsflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface DocsflowStageOverride {
	model?: string;
	thinking?: DocsflowThinkingLevel;
	timeoutMs?: number;
}

export interface DocsflowConfig {
	/** When false (default), write under the session cwd. */
	vaultEnabled: boolean;
	/** When false, skip session/start vault-mode reminder. Default true. */
	configReminder: boolean;
	vaultRoot: string;
	projectBase: string;
	stageOverrides: Partial<Record<DocsStage, DocsflowStageOverride>>;
}

export const TERRIFIC_CONFIG_BASENAME = "terrific.json";

const DOCSFLOW_STAGES: readonly DocsStage[] = ["research", "product", "interface", "delivery"];
const THINKING_LEVELS = new Set<DocsflowThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function resolveConfigPath(agentDir: string): string {
	return path.join(agentDir, TERRIFIC_CONFIG_BASENAME);
}

function parseBool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
	if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStageOverrides(value: unknown): DocsflowConfig["stageOverrides"] {
	if (!isRecord(value)) return {};
	const overrides: DocsflowConfig["stageOverrides"] = {};
	for (const stage of DOCSFLOW_STAGES) {
		const raw = value[stage];
		if (!isRecord(raw)) continue;
		const model = typeof raw.model === "string" && raw.model.trim().indexOf("/") > 0
			? raw.model.trim()
			: undefined;
		const thinking = typeof raw.thinking === "string" && THINKING_LEVELS.has(raw.thinking as DocsflowThinkingLevel)
			? raw.thinking as DocsflowThinkingLevel
			: undefined;
		const timeoutMs = typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
			? Math.min(900_000, Math.max(1_000, Math.floor(raw.timeoutMs)))
			: undefined;
		if (model || thinking || timeoutMs !== undefined) {
			overrides[stage] = {
				...(model ? { model } : {}),
				...(thinking ? { thinking } : {}),
				...(timeoutMs !== undefined ? { timeoutMs } : {}),
			};
		}
	}
	return overrides;
}

export function loadDocsflowConfig(agentDir = path.join(homedir(), ".pi/agent")): DocsflowConfig {
	let vaultEnabled = false;
	let configReminder = true;
	let vaultRoot = DEFAULT_VAULT_ROOT;
	let projectBase = DEFAULT_PROJECT_BASE;
	let stageOverrides: DocsflowConfig["stageOverrides"] = {};

	const envEnabled = parseBool(process.env.DOCSFLOW_VAULT_ENABLED);
	if (envEnabled !== undefined) vaultEnabled = envEnabled;

	const envReminder = parseBool(process.env.DOCSFLOW_CONFIG_REMINDER);
	if (envReminder !== undefined) configReminder = envReminder;

	const fromEnvRoot = process.env.DOCSFLOW_VAULT?.trim();
	if (fromEnvRoot) vaultRoot = fromEnvRoot;

	const configPath = resolveConfigPath(agentDir);
	if (existsSync(configPath)) {
		try {
			const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
			const cfg = isRecord(raw) && isRecord(raw.docsflow) ? raw.docsflow : {};
			const fileEnabled = parseBool(cfg.vaultEnabled);
			if (fileEnabled !== undefined) vaultEnabled = fileEnabled;
			const fileReminder = parseBool(cfg.configReminder);
			if (fileReminder !== undefined) configReminder = fileReminder;
			if (typeof cfg.vaultRoot === "string" && cfg.vaultRoot.trim()) vaultRoot = cfg.vaultRoot.trim();
			if (typeof cfg.projectBase === "string" && cfg.projectBase.trim()) {
				try {
					projectBase = normalizeProjectBase(cfg.projectBase);
				} catch {
					// Ignore invalid persisted project bases and retain the safe default.
				}
			}
			stageOverrides = parseStageOverrides(cfg.stageOverrides);
		} catch {
			// ignore malformed config while reading; writes still refuse to replace it.
		}
	}

	return {
		vaultEnabled,
		configReminder,
		vaultRoot: normalizeVaultRoot(vaultRoot),
		projectBase,
		stageOverrides,
	};
}

function mutateDocsflowConfig(
	agentDir: string,
	mutate: (docsflow: Record<string, unknown>) => void,
): DocsflowConfig {
	const configPath = resolveConfigPath(agentDir);
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const lockPath = `${configPath}.lock`;
	let lock: number;
	try {
		lock = openSync(lockPath, "wx", 0o600);
		closeSync(lock);
	} catch (error) {
		throw new Error(`Failed to lock ${TERRIFIC_CONFIG_BASENAME}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const temporary = path.join(agentDir, `.${TERRIFIC_CONFIG_BASENAME}.${process.pid}.${randomUUID()}.tmp`);
	try {
		let raw: Record<string, unknown> = {};
		if (existsSync(configPath)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(configPath, "utf8"));
			} catch (error) {
				throw new Error(`Failed to parse ${TERRIFIC_CONFIG_BASENAME}: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (!isRecord(parsed)) throw new Error(`${TERRIFIC_CONFIG_BASENAME} root must be an object`);
			raw = parsed;
		}
		if (Object.hasOwn(raw, "docsflow") && !isRecord(raw.docsflow)) {
			throw new Error("docsflow must be a JSON object");
		}
		const docsflow = isRecord(raw.docsflow) ? raw.docsflow : {};
		mutate(docsflow);
		if (Object.keys(docsflow).length === 0) delete raw.docsflow;
		else raw.docsflow = docsflow;

		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
			chmodSync(temporary, existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o600);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, configPath);
		return loadDocsflowConfig(agentDir);
	} finally {
		try {
			unlinkSync(temporary);
		} catch {}
		try {
			unlinkSync(lockPath);
		} catch {}
	}
}

/** Patch docsflow keys in terrific.json (preserves other top-level keys). */
export function updateDocsflowConfig(
	agentDir: string,
	patch: Partial<Pick<DocsflowConfig, "vaultEnabled" | "configReminder" | "vaultRoot" | "projectBase" | "stageOverrides">>,
): DocsflowConfig {
	return mutateDocsflowConfig(agentDir, (docsflow) => {
		if (patch.vaultEnabled !== undefined) docsflow.vaultEnabled = patch.vaultEnabled;
		if (patch.configReminder !== undefined) docsflow.configReminder = patch.configReminder;
		if (patch.vaultRoot !== undefined) docsflow.vaultRoot = patch.vaultRoot;
		if (patch.projectBase !== undefined) docsflow.projectBase = normalizeProjectBase(patch.projectBase);
		if (patch.stageOverrides !== undefined) {
			if (Object.hasOwn(docsflow, "stageOverrides") && !isRecord(docsflow.stageOverrides)) {
				throw new Error("docsflow.stageOverrides must be a JSON object");
			}
			const stages = isRecord(docsflow.stageOverrides) ? docsflow.stageOverrides : {};
			for (const stage of DOCSFLOW_STAGES) {
				const override = patch.stageOverrides[stage];
				if (!override) continue;
				if (Object.hasOwn(stages, stage) && !isRecord(stages[stage])) {
					throw new Error(`docsflow.stageOverrides.${stage} must be a JSON object`);
				}
				stages[stage] = { ...(isRecord(stages[stage]) ? stages[stage] : {}), ...override };
			}
			docsflow.stageOverrides = stages;
		}
	});
}

export function updateDocsflowStageOverride(
	agentDir: string,
	stage: DocsStage,
	patch: Partial<DocsflowStageOverride>,
): DocsflowConfig {
	return mutateDocsflowConfig(agentDir, (docsflow) => {
		if (Object.hasOwn(docsflow, "stageOverrides") && !isRecord(docsflow.stageOverrides)) {
			throw new Error("docsflow.stageOverrides must be a JSON object");
		}
		const stages = isRecord(docsflow.stageOverrides) ? docsflow.stageOverrides : {};
		if (Object.hasOwn(stages, stage) && !isRecord(stages[stage])) {
			throw new Error(`docsflow.stageOverrides.${stage} must be a JSON object`);
		}
		const override = isRecord(stages[stage]) ? stages[stage] : {};
		for (const field of ["model", "thinking", "timeoutMs"] as const) {
			if (!(field in patch)) continue;
			const value = patch[field];
			if (value === undefined) delete override[field];
			else override[field] = value;
		}
		if (Object.keys(override).length === 0) delete stages[stage];
		else stages[stage] = override;
		if (Object.keys(stages).length === 0) delete docsflow.stageOverrides;
		else docsflow.stageOverrides = stages;
	});
}

/** @deprecated use loadDocsflowConfig */
export const loadVaultConfig = loadDocsflowConfig;

export function normalizeVaultRoot(value: string): string {
	let root = value.trim().replaceAll("\\", "/");
	const win = root.match(/^([A-Za-z]):\/?(.*)$/);
	if (win) {
		const drive = win[1]!.toLowerCase();
		const rest = win[2] ?? "";
		root = path.posix.join("/mnt", drive, rest);
	}
	return path.resolve(root);
}

export function normalizeProjectBase(value: string): string {
	const normalized = value.trim().replaceAll("\\", "/");
	if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
		throw new Error("projectBase must be a relative path inside vaultRoot");
	}
	const relative = path.posix.normalize(normalized).replace(/^\.\//, "");
	if (!relative || relative === ".." || relative.startsWith("../") || relative.includes("/../")) {
		throw new Error("projectBase must stay inside vaultRoot");
	}
	return relative;
}

export function defaultProjectSlug(cwd: string, explicit?: string): string {
	const value = (explicit ?? path.basename(path.resolve(cwd))).trim();
	if (!value || value === "." || value === "/" || value.includes("..")) {
		throw new Error("Invalid project slug");
	}
	return value.replaceAll("\\", "/").split("/").filter(Boolean).pop()!;
}

/** Local (default): <sessionCwd>/docsflow */
export function resolveLocalOutputRoot(projectRoot: string): string {
	return path.resolve(projectRoot, DOCSFLOW_DIRNAME);
}

/** Vault mode: <vault>/<projectBase>/<slug>/docsflow */
export function resolveVaultOutputRoot(config: DocsflowConfig, projectSlug: string): string {
	if (projectSlug.includes("..") || path.isAbsolute(projectSlug)) {
		throw new Error("projectSlug must be a single relative name");
	}
	if (!existsSync(config.vaultRoot)) {
		throw new Error(
			`Obsidian vault not found: ${config.vaultRoot}. Set docsflow.vaultRoot or disable vault (docsflow.vaultEnabled=false).`,
		);
	}
	const vaultRoot = path.resolve(config.vaultRoot);
	const outputRoot = path.resolve(vaultRoot, normalizeProjectBase(config.projectBase), projectSlug, DOCSFLOW_DIRNAME);
	const relative = path.relative(vaultRoot, outputRoot);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("projectBase must stay inside vaultRoot");
	}
	return outputRoot;
}

export function resolveDocsflowOutputRoot(options: {
	config: DocsflowConfig;
	projectRoot: string;
	projectSlug: string;
}): string {
	if (!options.config.vaultEnabled) return resolveLocalOutputRoot(options.projectRoot);
	return resolveVaultOutputRoot(options.config, options.projectSlug);
}

export function describeOutputMode(config: DocsflowConfig, outputRoot: string, projectRoot?: string): string {
	if (!config.vaultEnabled) {
		if (projectRoot) {
			const rel = path.relative(projectRoot, outputRoot).split(path.sep).join("/");
			if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return `local:${rel}`;
		}
		return `local:${outputRoot}`;
	}
	try {
		const rel = path.relative(config.vaultRoot, outputRoot).split(path.sep).join("/");
		if (!rel.startsWith("..") && !path.isAbsolute(rel)) return `vault:${rel}`;
	} catch {
		// fall through
	}
	return `vault:${outputRoot}`;
}

export function vaultRelative(config: DocsflowConfig, absolutePath: string): string {
	const rel = path.relative(config.vaultRoot, absolutePath).split(path.sep).join("/");
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path escapes vault root");
	return rel;
}

export function vaultConfigReminder(config: DocsflowConfig): string {
	if (config.vaultEnabled) {
		return [
			"docsflow: Obsidian vault output is ON.",
			`vaultRoot=${config.vaultRoot}`,
			`projectBase=${config.projectBase}`,
			"Artifacts: <vault>/<projectBase>/<project>/docsflow/",
			"Disable: set docsflow.vaultEnabled=false in ~/.pi/agent/terrific.json",
			"Mute this reminder: /docsflow remind off",
		].join(" ");
	}
	return [
		"docsflow: Obsidian vault output is OFF (default).",
		"Artifacts write under the session cwd: ./docsflow/",
		"Enable vault: set docsflow.vaultEnabled=true (and vaultRoot) in ~/.pi/agent/terrific.json",
		"or DOCSFLOW_VAULT_ENABLED=true.",
		"Mute this reminder: /docsflow remind off",
	].join(" ");
}
