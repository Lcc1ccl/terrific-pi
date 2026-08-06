import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelProfile, ModelProfileConfig, ProfileScope, ProjectProfileOverride, ThinkingLevel } from "./types.ts";

export const DEFAULT_CONFIG: ModelProfileConfig = {
	startup: false,
	startupScope: "session",
	openHotkey: "ctrl+alt+l",
	profiles: [],
};

export const TERRIFIC_CONFIG_BASENAME = "terrific.json";

const THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SCOPES = new Set<ProfileScope>(["session", "global"]);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING.has(value as ThinkingLevel);
}

export function isProfileScope(value: unknown): value is ProfileScope {
	return typeof value === "string" && SCOPES.has(value as ProfileScope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ConfigOverrides {
	startup?: boolean;
	startupScope?: ProfileScope;
	openHotkey?: string;
}

function asBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asScope(value: unknown, fallback: ProfileScope): ProfileScope {
	return isProfileScope(value) ? value : fallback;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asHotkey(value: unknown): string | undefined {
	const raw = asNonEmptyString(value);
	if (!raw) return undefined;
	return raw.toLowerCase().replace(/\s+/g, "");
}

/** Numeric profile id only: 1, "1", 2, ... */
export function asNumericId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return String(value);
	}
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		const n = Number(value.trim());
		if (n > 0) return String(n);
	}
	return undefined;
}

/** Alias: letters/digits/_/- ; stored lowercase. */
export function asAlias(value: unknown): string | undefined {
	const raw = asNonEmptyString(value);
	if (!raw) return undefined;
	const lower = raw.toLowerCase();
	if (!/^[a-z][a-z0-9_-]*$/.test(lower)) return undefined;
	return lower;
}

export function defaultHotkeyForId(id: string): string | undefined {
	const n = Number(id);
	if (!Number.isInteger(n) || n < 1 || n > 9) return undefined;
	// alt+N avoids common Windows terminal ctrl+alt bindings
	return `alt+${n}`;
}

function stripHotkey(profile: ModelProfile): ModelProfile {
	return {
		id: profile.id,
		alias: profile.alias,
		provider: profile.provider,
		model: profile.model,
		thinking: profile.thinking,
	};
}

/** Parse one profile object; returns undefined if required fields missing. */
export function parseProfile(raw: unknown, index: number): { profile?: ModelProfile; warning?: string } {
	if (!isRecord(raw)) {
		return { warning: `modelProfile.profiles[${index}] ignored: not an object` };
	}

	const id = asNumericId(raw.id);
	if (!id) {
		return {
			warning: `modelProfile.profiles[${index}] ignored: id must be a positive integer`,
		};
	}

	const provider = asNonEmptyString(raw.provider);
	const model = asNonEmptyString(raw.model);
	if (!provider || !model) {
		return {
			warning: `modelProfile.profiles[${index}] (id=${id}) ignored: provider and model are required`,
		};
	}

	if (!isThinkingLevel(raw.thinking)) {
		return {
			warning: `modelProfile.profiles[${index}] (id=${id}) ignored: invalid thinking level`,
		};
	}

	const aliasRaw = raw.alias !== undefined ? asAlias(raw.alias) : undefined;
	if (raw.alias !== undefined && !aliasRaw) {
		return {
			warning: `modelProfile.profiles[${index}] (id=${id}) ignored: invalid alias (use [a-z][a-z0-9_-]*)`,
		};
	}
	// id 1 defaults alias to "default" when omitted
	const alias = aliasRaw ?? (id === "1" ? "default" : `p${id}`);

	const explicitHotkey = asHotkey(raw.hotkey);
	const hotkey = explicitHotkey ?? defaultHotkeyForId(id);

	const profile: ModelProfile = {
		id,
		alias,
		provider,
		model,
		thinking: raw.thinking,
		...(hotkey ? { hotkey } : {}),
	};
	return { profile };
}

/** Merge a modelProfile section (or full terrific.json root) into a safe config. */
export function mergeConfig(raw: unknown): {
	config: ModelProfileConfig;
	warnings: string[];
	overrides: ConfigOverrides;
} {
	const warnings: string[] = [];
	if (raw === undefined || raw === null) {
		return { config: { ...DEFAULT_CONFIG, profiles: [] }, warnings, overrides: {} };
	}
	if (!isRecord(raw)) {
		warnings.push("modelProfile ignored: expected an object");
		return { config: { ...DEFAULT_CONFIG, profiles: [] }, warnings, overrides: {} };
	}

	const section = isRecord(raw.modelProfile) ? raw.modelProfile : raw;
	const startupOverride = typeof section.startup === "boolean" ? section.startup : undefined;
	const startupScopeOverride = isProfileScope(section.startupScope) ? section.startupScope : undefined;
	const openHotkeyOverride = asHotkey(section.openHotkey);
	const startup = asBool(section.startup, DEFAULT_CONFIG.startup);
	const startupScope = asScope(section.startupScope, DEFAULT_CONFIG.startupScope);
	const openHotkey = openHotkeyOverride ?? DEFAULT_CONFIG.openHotkey;

	const profiles: ModelProfile[] = [];
	const seenIds = new Set<string>();
	const seenAliases = new Set<string>();
	const seenHotkeys = new Set<string>();
	const list = Array.isArray(section.profiles) ? section.profiles : [];

	if (section.profiles !== undefined && !Array.isArray(section.profiles)) {
		warnings.push("modelProfile.profiles ignored: expected an array");
	}

	for (let i = 0; i < list.length; i++) {
		const { profile, warning } = parseProfile(list[i], i);
		if (warning) warnings.push(warning);
		if (!profile) continue;

		if (seenIds.has(profile.id)) {
			warnings.push(`modelProfile: duplicate id "${profile.id}" ignored`);
			continue;
		}
		if (seenAliases.has(profile.alias)) {
			warnings.push(`modelProfile: duplicate alias "${profile.alias}" on id ${profile.id} ignored`);
			continue;
		}

		seenIds.add(profile.id);
		seenAliases.add(profile.alias);

		if (profile.hotkey) {
			if (seenHotkeys.has(profile.hotkey)) {
				warnings.push(`modelProfile: duplicate hotkey "${profile.hotkey}" on id ${profile.id} dropped`);
				profiles.push(stripHotkey(profile));
				continue;
			}
			seenHotkeys.add(profile.hotkey);
		}

		profiles.push(profile);
	}

	profiles.sort((a, b) => Number(a.id) - Number(b.id));

	if (profiles.length > 8) {
		warnings.push(`modelProfile: ${profiles.length} profiles configured; short lists (3–5) work best`);
	}

	return {
		config: { startup, startupScope, openHotkey, profiles },
		warnings,
		overrides: {
			...(startupOverride !== undefined ? { startup: startupOverride } : {}),
			...(startupScopeOverride !== undefined ? { startupScope: startupScopeOverride } : {}),
			...(openHotkeyOverride !== undefined ? { openHotkey: openHotkeyOverride } : {}),
		},
	};
}

export function resolveConfigPath(dir: string): string {
	return join(dir, TERRIFIC_CONFIG_BASENAME);
}

export function resolveConfigPaths(
	cwd: string,
	agentDir: string,
	projectTrusted: boolean,
	configDirName: string,
): string[] {
	const paths = [resolveConfigPath(agentDir)];
	if (projectTrusted) {
		paths.push(resolveConfigPath(join(cwd, configDirName)));
	}
	return paths;
}

function readJsonFile(path: string): { value?: unknown; warning?: string } {
	if (!existsSync(path)) return {};
	try {
		return { value: JSON.parse(readFileSync(path, "utf8")) as unknown };
	} catch (error) {
		return {
			warning: `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function parseProjectProfileOverride(raw: unknown, index: number): { override?: ProjectProfileOverride; warning?: string } {
	if (!isRecord(raw)) return { warning: `modelProfile.profiles[${index}] ignored: not an object` };
	const id = asNumericId(raw.id);
	if (!id) return { warning: `modelProfile.profiles[${index}] ignored: id must be a positive integer` };

	const providerPresent = Object.hasOwn(raw, "provider");
	const modelPresent = Object.hasOwn(raw, "model");
	const provider = providerPresent ? asNonEmptyString(raw.provider) : undefined;
	const model = modelPresent ? asNonEmptyString(raw.model) : undefined;
	if ((providerPresent || modelPresent) && (!provider || !model)) {
		return { warning: `modelProfile.profiles[${index}] (id=${id}) ignored: provider and model must be set together` };
	}

	const thinkingPresent = Object.hasOwn(raw, "thinking");
	const thinking = thinkingPresent && isThinkingLevel(raw.thinking) ? raw.thinking : undefined;
	if (thinkingPresent && thinking === undefined) {
		return { warning: `modelProfile.profiles[${index}] (id=${id}) ignored: invalid thinking level` };
	}
	if (!provider && !thinking) {
		return { warning: `modelProfile.profiles[${index}] (id=${id}) ignored: no model or thinking override` };
	}
	return { override: { id, ...(provider ? { provider, model: model! } : {}), ...(thinking ? { thinking } : {}) } };
}

function parseProjectProfileOverrides(section: unknown): { overrides: ProjectProfileOverride[]; warnings: string[] } {
	if (!isRecord(section)) return { overrides: [], warnings: [] };
	if (section.profiles !== undefined && !Array.isArray(section.profiles)) {
		return { overrides: [], warnings: ["modelProfile.profiles ignored: expected an array"] };
	}
	const warnings: string[] = [];
	const overrides: ProjectProfileOverride[] = [];
	const seenIds = new Set<string>();
	for (const [index, raw] of (Array.isArray(section.profiles) ? section.profiles : []).entries()) {
		const { override, warning } = parseProjectProfileOverride(raw, index);
		if (warning) warnings.push(warning);
		if (!override) continue;
		if (seenIds.has(override.id)) {
			warnings.push(`modelProfile: duplicate project override id "${override.id}" ignored`);
			continue;
		}
		seenIds.add(override.id);
		overrides.push(override);
	}
	return { overrides, warnings };
}

function extractSection(root: unknown): unknown | undefined {
	if (!isRecord(root)) return undefined;
	if (isRecord(root.modelProfile)) return root.modelProfile;
	if (
		Array.isArray(root.profiles)
		|| "startup" in root
		|| "startupScope" in root
		|| "openHotkey" in root
	) return root;
	return undefined;
}

export type ProfileConfigSource = "global" | "project";

export function loadProjectProfileOverrides(configDir: string): { overrides: ProjectProfileOverride[]; warnings: string[] } {
	const { value, warning } = readJsonFile(resolveConfigPath(configDir));
	if (warning) return { overrides: [], warnings: [warning] };
	const section = extractSection(value);
	return parseProjectProfileOverrides(section);
}

/**
 * Load modelProfile from global (+ trusted project) terrific.json.
 * Trusted projects may override a global profile's provider/model and thinking by id.
 */
export function loadConfigWithSources(
	cwd: string,
	agentDir: string,
	projectTrusted: boolean,
	configDirName: string,
): { config: ModelProfileConfig; warnings: string[]; profileSources: Record<string, ProfileConfigSource> } {
	const warnings: string[] = [];
	const paths = resolveConfigPaths(cwd, agentDir, projectTrusted, configDirName);

	let startup = DEFAULT_CONFIG.startup;
	let startupScope = DEFAULT_CONFIG.startupScope;
	let openHotkey = DEFAULT_CONFIG.openHotkey;
	const byId = new Map<string, ModelProfile>();
	const profileSources: Record<string, ProfileConfigSource> = {};

	for (const [index, path] of paths.entries()) {
		const { value, warning } = readJsonFile(path);
		if (warning) warnings.push(warning);
		if (value === undefined) continue;

		const section = extractSection(value);
		if (section === undefined) continue;
		if (index === 0) {
			const { config, warnings: sectionWarnings, overrides } = mergeConfig(section);
			for (const w of sectionWarnings) warnings.push(`${path}: ${w}`);
			if (overrides.startup !== undefined) startup = overrides.startup;
			if (overrides.startupScope !== undefined) startupScope = overrides.startupScope;
			if (overrides.openHotkey !== undefined) openHotkey = overrides.openHotkey;
			for (const profile of config.profiles) {
				byId.set(profile.id, profile);
				profileSources[profile.id] = "global";
			}
			continue;
		}

		const { overrides, warnings: sectionWarnings } = parseProjectProfileOverrides(section);
		for (const w of sectionWarnings) warnings.push(`${path}: ${w}`);
		for (const override of overrides) {
			const profile = byId.get(override.id);
			if (!profile) {
				warnings.push(`${path}: modelProfile project override id "${override.id}" has no global profile`);
				continue;
			}
			byId.set(override.id, {
				...profile,
				...(override.provider ? { provider: override.provider, model: override.model! } : {}),
				...(override.thinking ? { thinking: override.thinking } : {}),
			});
			profileSources[override.id] = "project";
		}
	}

	const profiles = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));

	return {
		config: {
			startup,
			startupScope,
			openHotkey,
			profiles,
		},
		warnings,
		profileSources,
	};
}

export function loadConfig(
	cwd: string,
	agentDir: string,
	projectTrusted: boolean,
	configDirName: string,
): { config: ModelProfileConfig; warnings: string[] } {
	const { config, warnings } = loadConfigWithSources(cwd, agentDir, projectTrusted, configDirName);
	return { config, warnings };
}

export function findProfileById(profiles: readonly ModelProfile[], id: string): ModelProfile | undefined {
	const key = id.trim();
	if (!key) return undefined;
	return profiles.find((p) => p.id === key || p.id === String(Number(key)));
}

export function findProfileByAlias(profiles: readonly ModelProfile[], alias: string): ModelProfile | undefined {
	const key = alias.trim().toLowerCase();
	if (!key) return undefined;
	return profiles.find((p) => p.alias === key);
}

/** Resolve by numeric id or alias (case-insensitive for alias). */
export function findProfile(profiles: readonly ModelProfile[], ref: string): ModelProfile | undefined {
	const key = ref.trim();
	if (!key) return undefined;
	return findProfileById(profiles, key) ?? findProfileByAlias(profiles, key);
}

export function findProfileByHotkey(profiles: readonly ModelProfile[], hotkey: string): ModelProfile | undefined {
	const key = hotkey.trim().toLowerCase().replace(/\s+/g, "");
	if (!key) return undefined;
	return profiles.find((p) => p.hotkey === key);
}

export function profileLabel(profile: ModelProfile): string {
	const hotkey = profile.hotkey ? `  [${profile.hotkey}]` : "";
	return `${profile.id} · ${profile.alias} — ${profile.provider}/${profile.model} · ${profile.thinking}${hotkey}`;
}
