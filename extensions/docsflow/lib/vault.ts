import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Optional Obsidian vault defaults (only used when vaultEnabled=true). */
export const DEFAULT_VAULT_ROOT = "/mnt/g/Mindriver";
export const DEFAULT_PROJECT_BASE = "2_Career/01-INDIE/开发";
export const DOCSFLOW_DIRNAME = "docsflow";

export interface DocsflowConfig {
	/** When false (default), write under the session cwd. */
	vaultEnabled: boolean;
	/** When false, skip session/start vault-mode reminder. Default true. */
	configReminder: boolean;
	vaultRoot: string;
	projectBase: string;
}

export const TERRIFIC_CONFIG_BASENAME = "terrific.json";

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

export function loadDocsflowConfig(agentDir = path.join(homedir(), ".pi/agent")): DocsflowConfig {
	let vaultEnabled = false;
	let configReminder = true;
	let vaultRoot = DEFAULT_VAULT_ROOT;
	let projectBase = DEFAULT_PROJECT_BASE;

	const envEnabled = parseBool(process.env.DOCSFLOW_VAULT_ENABLED);
	if (envEnabled !== undefined) vaultEnabled = envEnabled;

	const envReminder = parseBool(process.env.DOCSFLOW_CONFIG_REMINDER);
	if (envReminder !== undefined) configReminder = envReminder;

	const fromEnvRoot = process.env.DOCSFLOW_VAULT?.trim();
	if (fromEnvRoot) vaultRoot = fromEnvRoot;

	const configPath = resolveConfigPath(agentDir);
	if (existsSync(configPath)) {
		try {
			const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
				docsflow?: {
					vaultEnabled?: unknown;
					configReminder?: unknown;
					vaultRoot?: string;
					projectBase?: string;
				};
			};
			const cfg = raw.docsflow;
			const fileEnabled = parseBool(cfg?.vaultEnabled);
			if (fileEnabled !== undefined) vaultEnabled = fileEnabled;
			const fileReminder = parseBool(cfg?.configReminder);
			if (fileReminder !== undefined) configReminder = fileReminder;
			if (cfg?.vaultRoot?.trim()) vaultRoot = cfg.vaultRoot.trim();
			if (cfg?.projectBase?.trim()) projectBase = cfg.projectBase.trim().replaceAll("\\", "/");
		} catch {
			// ignore malformed config
		}
	}

	return {
		vaultEnabled,
		configReminder,
		vaultRoot: normalizeVaultRoot(vaultRoot),
		projectBase,
	};
}

/** Patch docsflow keys in terrific.json (preserves other top-level keys). */
export function updateDocsflowConfig(
	agentDir: string,
	patch: Partial<Pick<DocsflowConfig, "vaultEnabled" | "configReminder" | "vaultRoot" | "projectBase">>,
): DocsflowConfig {
	const configPath = resolveConfigPath(agentDir);
	let raw: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				raw = parsed as Record<string, unknown>;
			}
		} catch {
			// start from empty if malformed
		}
	}
	const prev =
		raw.docsflow && typeof raw.docsflow === "object" && !Array.isArray(raw.docsflow)
			? (raw.docsflow as Record<string, unknown>)
			: {};
	raw.docsflow = { ...prev, ...patch };
	writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	return loadDocsflowConfig(agentDir);
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
	return path.resolve(config.vaultRoot, config.projectBase, projectSlug, DOCSFLOW_DIRNAME);
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
