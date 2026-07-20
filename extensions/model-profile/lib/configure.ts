import { asAlias, DEFAULT_CONFIG, defaultHotkeyForId, loadConfig, loadConfigWithSources, profileLabel, resolveConfigPath } from "./config.ts";
import { patchModelProfileSection } from "./config-write.ts";
import type { ModelProfile, ModelProfileConfig, ProfileScope, ThinkingLevel } from "./types.ts";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ProfileConfiguratorUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, initialValue?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	pickModel(title: string, current: string | undefined, modelRefs: readonly string[]): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface ProfileConfiguratorDeps {
	agentDir: string;
	/** Trusted project config directory (for example <cwd>/.pi), when available. */
	projectDir?: string;
	cwd?: string;
	configDirName?: string;
	currentModel?: { provider: string; id: string };
	currentThinking: ThinkingLevel;
	getCurrentSession?(): { model?: { provider: string; id: string }; thinking: ThinkingLevel };
	modelRefs: readonly string[];
	quickApply(): Promise<void>;
	getEffectiveConfig?(): { config: ModelProfileConfig; source: string; profileSources?: Record<string, "global" | "project"> };
	ui: ProfileConfiguratorUi;
}

function loadGlobal(agentDir: string) {
	return loadConfig(agentDir, agentDir, false, ".pi");
}

function currentSession(deps: ProfileConfiguratorDeps) {
	return deps.getCurrentSession?.() ?? { model: deps.currentModel, thinking: deps.currentThinking };
}

export function nextProfileId(profiles: readonly ModelProfile[]): string {
	return String(profiles.reduce((max, profile) => Math.max(max, Number(profile.id) || 0), 0) + 1);
}

function normalizeHotkey(value: string): string {
	return value.toLowerCase().replace(/\s+/g, "");
}

function splitModelRef(value: string): { provider: string; model: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function persistProfiles(deps: ProfileConfiguratorDeps, profiles: ModelProfile[]): boolean {
	const result = patchModelProfileSection({ profiles }, deps.agentDir);
	if (result.ok) return true;
	deps.ui.notify(`Failed to update terrific.json: ${result.error}`, "error");
	return false;
}

function projectContext(deps: ProfileConfiguratorDeps): { cwd: string; dir: string; configDirName: string } | undefined {
	if (!deps.projectDir || !deps.cwd) return undefined;
	return { cwd: deps.cwd, dir: deps.projectDir, configDirName: deps.configDirName ?? ".pi" };
}

function persistProjectProfiles(deps: ProfileConfiguratorDeps, profiles: ModelProfile[]): boolean {
	const project = projectContext(deps);
	if (!project) return false;
	const result = patchModelProfileSection({ profiles }, project.dir);
	if (result.ok) return true;
	deps.ui.notify(`Failed to update project terrific.json: ${result.error}`, "error");
	return false;
}

async function addCurrentProfile(deps: ProfileConfiguratorDeps): Promise<void> {
	const current = currentSession(deps);
	if (!current.model) {
		deps.ui.notify("No active model is available to save", "warning");
		return;
	}
	const { config } = loadGlobal(deps.agentDir);
	const id = nextProfileId(config.profiles);
	const suggestedAlias = id === "1" ? "default" : `p${id}`;
	const aliasInput = await deps.ui.input("Profile alias ([a-z][a-z0-9_-]*)", suggestedAlias);
	if (aliasInput === undefined) return;
	const alias = asAlias(aliasInput || suggestedAlias);
	if (!alias) {
		deps.ui.notify("Invalid alias; use [a-z][a-z0-9_-]*", "warning");
		return;
	}
	if (config.profiles.some((profile) => profile.alias === alias)) {
		deps.ui.notify(`Alias "${alias}" is already used`, "warning");
		return;
	}

	const labelInput = await deps.ui.input("Profile label", alias);
	if (labelInput === undefined) return;
	const label = labelInput.trim() || alias;
	const defaultHotkey = defaultHotkeyForId(id) ?? "";
	const hotkeyInput = await deps.ui.input("Profile hotkey (blank uses default)", defaultHotkey);
	if (hotkeyInput === undefined) return;
	const hotkey = normalizeHotkey(hotkeyInput || defaultHotkey);
	if (hotkey && (config.openHotkey === hotkey || config.profiles.some((profile) => profile.hotkey === hotkey))) {
		deps.ui.notify(`Hotkey "${hotkey}" is already used`, "warning");
		return;
	}

	const profile: ModelProfile = {
		id,
		alias,
		label,
		provider: current.model.provider,
		model: current.model.id,
		thinking: current.thinking,
		...(hotkey ? { hotkey } : {}),
	};
	if (persistProfiles(deps, [...config.profiles, profile])) {
		deps.ui.notify(`Saved ${profileLabel(profile)}. Run /reload to register its hotkey.`, "info");
	}
}

async function editProfile(deps: ProfileConfiguratorDeps, id: string): Promise<"back" | "deleted"> {
	while (true) {
		const { config } = loadGlobal(deps.agentDir);
		const profile = config.profiles.find((candidate) => candidate.id === id);
		if (!profile) return "deleted";
		const choice = await deps.ui.select(profileLabel(profile), [
			`Label: ${profile.label}`,
			`Alias: ${profile.alias}`,
			`Model: ${profile.provider}/${profile.model}`,
			`Thinking: ${profile.thinking}`,
			`Hotkey: ${profile.hotkey ?? "none"}`,
			"Delete profile",
			"Back",
		]);
		if (!choice || choice === "Back") return "back";

		let replacement: ModelProfile | undefined;
		if (choice.startsWith("Label:")) {
			const value = await deps.ui.input("Profile label", profile.label);
			if (value === undefined) continue;
			if (!value.trim()) {
				deps.ui.notify("Label cannot be empty", "warning");
				continue;
			}
			replacement = { ...profile, label: value.trim() };
		} else if (choice.startsWith("Alias:")) {
			const value = await deps.ui.input("Profile alias", profile.alias);
			if (value === undefined) continue;
			const alias = asAlias(value);
			if (!alias || config.profiles.some((candidate) => candidate.id !== id && candidate.alias === alias)) {
				deps.ui.notify("Alias is invalid or already used", "warning");
				continue;
			}
			replacement = { ...profile, alias };
		} else if (choice.startsWith("Model:")) {
			const ref = await deps.ui.pickModel("Profile model", `${profile.provider}/${profile.model}`, deps.modelRefs);
			const model = ref ? splitModelRef(ref) : undefined;
			if (!model) continue;
			replacement = { ...profile, ...model };
		} else if (choice.startsWith("Thinking:")) {
			const thinking = await deps.ui.select("Thinking level", THINKING_LEVELS);
			if (!thinking) continue;
			replacement = { ...profile, thinking: thinking as ThinkingLevel };
		} else if (choice.startsWith("Hotkey:")) {
			const value = await deps.ui.input("Profile hotkey", profile.hotkey ?? "");
			if (value === undefined || !value.trim()) continue;
			const hotkey = normalizeHotkey(value);
			if (config.openHotkey === hotkey || config.profiles.some((candidate) => candidate.id !== id && candidate.hotkey === hotkey)) {
				deps.ui.notify(`Hotkey "${hotkey}" is already used`, "warning");
				continue;
			}
			replacement = { ...profile, hotkey };
		} else if (choice === "Delete profile") {
			if (!await deps.ui.confirm("Delete profile", `Delete ${profileLabel(profile)}? This cannot be undone.`)) continue;
			if (persistProfiles(deps, config.profiles.filter((candidate) => candidate.id !== id))) {
				deps.ui.notify("Profile deleted. Run /reload to remove its registered hotkey.", "info");
				return "deleted";
			}
			continue;
		}

		if (replacement) {
			persistProfiles(deps, config.profiles.map((candidate) => candidate.id === id ? replacement! : candidate));
		}
	}
}

async function manageProfiles(deps: ProfileConfiguratorDeps): Promise<void> {
	while (true) {
		const { config } = loadGlobal(deps.agentDir);
		const options = [
			...config.profiles.map((profile) => `${profile.id} · ${profile.alias}: ${profile.provider}/${profile.model} · ${profile.thinking}`),
			"Back",
		];
		const choice = await deps.ui.select("Manage profiles", options);
		if (!choice || choice === "Back") return;
		const id = choice.split(" ", 1)[0];
		if (await editProfile(deps, id) === "deleted") return;
	}
}

async function editProjectOverride(deps: ProfileConfiguratorDeps, id: string): Promise<void> {
	const project = projectContext(deps);
	if (!project) return;
	while (true) {
		const effective = loadConfigWithSources(project.cwd, deps.agentDir, true, project.configDirName);
		const base = effective.config.profiles.find((profile) => profile.id === id);
		const local = loadConfig(project.dir, project.dir, false, project.configDirName).config;
		const override = local.profiles.find((profile) => profile.id === id);
		const profile = override ?? base;
		if (!profile) return;
		const choice = await deps.ui.select(`${profileLabel(profile)} · source ${override ? "project" : effective.profileSources[id] ?? "global"}`, [
			`Model: ${profile.provider}/${profile.model}`,
			`Thinking: ${profile.thinking}`,
			...(override ? ["Reset project override"] : []),
			"Back",
		]);
		if (!choice || choice === "Back") return;
		let replacement: ModelProfile | undefined;
		if (choice.startsWith("Model:")) {
			const ref = await deps.ui.pickModel("Project override model", `${profile.provider}/${profile.model}`, deps.modelRefs);
			const model = ref ? splitModelRef(ref) : undefined;
			if (!model) continue;
			replacement = { ...profile, ...model };
		} else if (choice.startsWith("Thinking:")) {
			const thinking = await deps.ui.select("Project override thinking", THINKING_LEVELS);
			if (!thinking) continue;
			replacement = { ...profile, thinking: thinking as ThinkingLevel };
		} else if (choice === "Reset project override") {
			if (!await deps.ui.confirm("Reset project profile override?", `Remove project override for ${profile.alias} and inherit the global profile?`)) continue;
			if (persistProjectProfiles(deps, local.profiles.filter((candidate) => candidate.id !== id))) {
				deps.ui.notify(`Project override reset for ${profile.alias}`, "info");
			}
			continue;
		}
		if (replacement && persistProjectProfiles(deps, [
			...local.profiles.filter((candidate) => candidate.id !== id),
			replacement,
		])) {
			deps.ui.notify(`Project override saved for ${replacement.alias}`, "info");
		}
	}
}

async function manageProjectOverrides(deps: ProfileConfiguratorDeps): Promise<void> {
	const project = projectContext(deps);
	if (!project) return;
	while (true) {
		const effective = loadConfigWithSources(project.cwd, deps.agentDir, true, project.configDirName);
		const options = [
			...effective.config.profiles.map((profile) => `${profileLabel(profile)} · ${effective.profileSources[profile.id] ?? "global"}`),
			"Back",
		];
		const choice = await deps.ui.select("Project profile overrides", options);
		if (!choice || choice === "Back") return;
		const id = choice.split(" ", 1)[0];
		if (id) await editProjectOverride(deps, id);
	}
}

async function configureStartup(deps: ProfileConfiguratorDeps): Promise<void> {
	while (true) {
		const { config } = loadGlobal(deps.agentDir);
		const choice = await deps.ui.select("Startup & shortcuts", [
			`Startup picker: ${config.startup ? "On" : "Off"}`,
			`Startup scope: ${config.startupScope}`,
			`Open picker hotkey: ${config.openHotkey ?? "none"}`,
			"Back",
		]);
		if (!choice || choice === "Back") return;

		if (choice.startsWith("Startup picker:")) {
			const value = await deps.ui.select("Startup picker", ["On", "Off"]);
			if (!value) continue;
			const result = patchModelProfileSection({ startup: value === "On" }, deps.agentDir);
			if (!result.ok) deps.ui.notify(`Failed to update terrific.json: ${result.error}`, "error");
		} else if (choice.startsWith("Startup scope:")) {
			const value = await deps.ui.select("Startup apply scope", ["session", "global"]);
			if (!value) continue;
			const result = patchModelProfileSection({ startupScope: value as ProfileScope }, deps.agentDir);
			if (!result.ok) deps.ui.notify(`Failed to update terrific.json: ${result.error}`, "error");
		} else if (choice.startsWith("Open picker hotkey:")) {
			const value = await deps.ui.input("Open picker hotkey", config.openHotkey ?? "");
			if (value === undefined || !value.trim()) continue;
			const hotkey = normalizeHotkey(value);
			if (config.profiles.some((profile) => profile.hotkey === hotkey)) {
				deps.ui.notify(`Hotkey "${hotkey}" is already used by a profile`, "warning");
				continue;
			}
			const result = patchModelProfileSection({ openHotkey: hotkey }, deps.agentDir);
			if (!result.ok) deps.ui.notify(`Failed to update terrific.json: ${result.error}`, "error");
			else deps.ui.notify("Hotkey saved. Run /reload to register it.", "info");
		}
	}
}

export async function runProfileConfigurator(deps: ProfileConfiguratorDeps): Promise<void> {
	const warned = new Set<string>();
	while (true) {
		const { config, warnings } = loadGlobal(deps.agentDir);
		for (const warning of warnings) {
			if (warned.has(warning)) continue;
			warned.add(warning);
			deps.ui.notify(warning, "warning");
		}
		const choice = await deps.ui.select(
			`Model profiles · ${config.profiles.length} saved · startup ${config.startup ? "on" : "off"}`,
			[
				"Quick apply",
				"Add current session",
				"Manage profiles",
				...(projectContext(deps) ? ["Project overrides"] : []),
				"Startup & shortcuts",
				"Show effective config",
				"Done",
			],
		);
		if (!choice || choice === "Done") return;
		if (choice === "Quick apply") await deps.quickApply();
		else if (choice === "Add current session") await addCurrentProfile(deps);
		else if (choice === "Manage profiles") await manageProfiles(deps);
		else if (choice === "Project overrides") await manageProjectOverrides(deps);
		else if (choice === "Startup & shortcuts") await configureStartup(deps);
		else if (choice === "Show effective config") {
			const effective = deps.getEffectiveConfig?.() ?? {
				config,
				source: `${resolveConfigPath(deps.agentDir)} (global)`,
			};
			const session = currentSession(deps);
			const current = session.model
				? `${session.model.provider}/${session.model.id} · ${session.thinking}`
				: `(none) · ${session.thinking}`;
			deps.ui.notify([
				`Current session: ${current}`,
				`Config source: ${effective.source}`,
				"Manager write scope: global profiles/startup; project overrides when selected",
				`Startup: ${effective.config.startup ? "on" : "off"} · preferred scope ${effective.config.startupScope}`,
				`Picker hotkey: ${effective.config.openHotkey ?? "none"}`,
				`Defaults: startup ${DEFAULT_CONFIG.startup ? "on" : "off"} · scope ${DEFAULT_CONFIG.startupScope} · picker ${DEFAULT_CONFIG.openHotkey}`,
				`Profiles (${effective.config.profiles.length}): ${effective.config.profiles.map((profile) => profileLabel(profile)).join(", ") || "(none)"}`,
				...(effective.profileSources ? [`Profile sources: ${effective.config.profiles.map((profile) => `${profile.alias}=${effective.profileSources?.[profile.id] ?? "global"}`).join(", ") || "(none)"}`] : []),
			].join("\n"), "info");
		}
	}
}
