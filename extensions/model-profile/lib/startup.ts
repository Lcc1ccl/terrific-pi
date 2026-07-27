import { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseKey } from "@earendil-works/pi-tui";

import type { ApplyResult, ModelProfile, ModelProfileConfig, ProfileScope, ThinkingLevel } from "./types.ts";
import { isThinkingLevel, profileLabel } from "./config.ts";
import {
	applyProfile,
	prepareSessionSettings,
	restoreSessionSettings,
	type ApplyDeps,
	type ModelRef,
} from "./apply.ts";
import type { SettingsDefaults } from "./settings-defaults.ts";

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/** session_start reasons that should open the startup picker. */
export const STARTUP_PICKER_REASONS = new Set<SessionStartReason>(["startup", "new"]);

export type StartupPickerResult =
	| { action: "skipped"; reason: string }
	| { action: "cancelled"; reason: string }
	| {
			action: "applied";
			source: "profile";
			profile: ModelProfile;
			scope: ProfileScope;
			result: ApplyResult;
	  }
	| {
			action: "applied";
			source: "manual" | "current";
			model: ModelRef;
			thinking: ThinkingLevel;
			scope: ProfileScope;
			settingsWritten?: boolean;
			settingsRestored?: boolean;
			settingsError?: string;
	  };

export interface StartupUi {
	select: (title: string, options: string[], initialSelectedValue?: string) => Promise<string | undefined>;
	selectStartup?: (title: string, options: string[]) => Promise<string | undefined>;
	selectScope?: (title: string, options: string[]) => Promise<string | undefined>;
	/** Type-to-filter model list (pi /model style). Falls back to select when omitted. */
	selectSearchable?: (
		title: string,
		items: ReadonlyArray<{ value: string; label: string; searchText?: string }>,
		settings?: { cancelAction?: "back" | "cancel"; initialSelectedValue?: string },
	) => Promise<string | undefined>;
}

export interface AvailableModel {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface StartupPickerInput {
	reason: SessionStartReason;
	hasUI: boolean;
	config: ModelProfileConfig;
	deps: ApplyDeps;
	ui: StartupUi;
	/** Keep-current target: activated global default on startup, previous session selection on /new. */
	currentModel?: ModelRef | null;
	currentThinking?: ThinkingLevel;
	/** Full registry of available models (auth-ready). */
	getAvailable: () => readonly AvailableModel[];
	/** Persist startup=false. Returning true keeps this picker open without the toggle. */
	disableStartup?: () => boolean;
	/** When true, after a pick also ask session vs global. Default true. */
	askScope?: boolean;
}

const SCOPE_SESSION = "session — this chat only";
const SCOPE_GLOBAL = "global — also update defaults";
const DISABLE_STARTUP = "Turn off future startup picker";
const BROWSE_ALL = "0 · Browse all models…";
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const CURRENT_SESSION_ENTRY = "model-profile-current";

export function supportedThinkingLevels(model: AvailableModel): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function startupDigitChoice(data: string, options: readonly string[]): string | undefined {
	const key = parseKey(data);
	if (!key || !/^\d$/.test(key)) return undefined;
	return options.find((option) => option.startsWith(`${key} · `));
}

/** Label for keeping the already-activated session model (not “settings default”). */
export function formatKeepCurrentLabel(
	model: ModelRef | null | undefined,
	thinking: ThinkingLevel | undefined,
): string {
	if (!model) {
		return "Keep current session model (none loaded)";
	}
	const think = thinking ?? "?";
	return `Keep current session · ${model.provider}/${model.id} · ${think}`;
}

export function formatKeepDefaultLabel(
	model: ModelRef | null | undefined,
	thinking: ThinkingLevel | undefined,
): string {
	if (!model) {
		return "Keep global default (none loaded)";
	}
	const think = thinking ?? "?";
	return `Keep global default · ${model.provider}/${model.id} · ${think}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SessionSelection = { model: ModelRef; thinking: ThinkingLevel };
type PendingNewSelection = SessionSelection & { targetSessionFile: string | undefined };
const pendingNewSelectionKey = Symbol.for("terrific-pi.model-profile.pending-new-selection");

function pendingNewSelectionStore(): Record<symbol, unknown> {
	return globalThis as Record<symbol, unknown>;
}

function isSessionSelection(value: unknown): value is SessionSelection {
	if (!isRecord(value) || !isRecord(value.model)) return false;
	return (
		typeof value.model.provider === "string"
		&& typeof value.model.id === "string"
		&& isThinkingLevel(value.thinking)
	);
}

/**
 * Bridge /new within this Pi process before the source session has its first
 * assistant response and therefore no JSONL file to read yet.
 */
export function rememberPendingNewSelection(
	targetSessionFile: string | undefined,
	selection: SessionSelection,
): void {
	pendingNewSelectionStore()[pendingNewSelectionKey] = { ...selection, targetSessionFile };
}

export function takePendingNewSelection(
	targetSessionFile: string | undefined,
): SessionSelection | undefined {
	const store = pendingNewSelectionStore();
	const pending = store[pendingNewSelectionKey];
	if (!isRecord(pending) || pending.targetSessionFile !== targetSessionFile || !isSessionSelection(pending)) {
		return undefined;
	}
	delete store[pendingNewSelectionKey];
	return { model: pending.model, thinking: pending.thinking };
}

export function readPreviousSessionSelection(
	path: string | undefined,
): { model: ModelRef; thinking: ThinkingLevel } | undefined {
	if (!path) return undefined;
	try {
		const branch = SessionManager.open(path).getBranch();
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (entry?.type !== "custom" || entry.customType !== CURRENT_SESSION_ENTRY || !isRecord(entry.data)) continue;
			const model = entry.data.model;
			const thinking = entry.data.thinking;
			if (
				isRecord(model)
				&& typeof model.provider === "string"
				&& typeof model.id === "string"
				&& isThinkingLevel(thinking)
			) {
				return { model: { provider: model.provider, id: model.id }, thinking };
			}
		}
	} catch {
		// A missing or malformed previous session falls back to the activated default.
	}
	return undefined;
}

export function formatManualApplyMessage(
	result: Extract<StartupPickerResult, { source: "manual" | "current" }>,
): string {
	const prefix = result.source === "current" ? "Kept current" : "Manual";
	const base = `${prefix}: ${result.model.provider}/${result.model.id} · ${result.thinking} (${result.scope})`;
	const lines = [base];
	if (result.scope === "global") {
		if (result.settingsWritten) {
			lines.push("Updated settings.json defaults (provider/model/thinking).");
		} else if (result.settingsError) {
			lines.push(`Session applied, but settings write failed: ${result.settingsError}`);
		}
	} else {
		if (result.settingsRestored) {
			lines.push("Restored original settings.json (session-only).");
		}
		if (result.settingsError) {
			lines.push(result.settingsError);
		}
	}
	return lines.join("\n");
}

export function manualResultLevel(
	result: Extract<StartupPickerResult, { source: "manual" | "current" }>,
): "info" | "warning" {
	if (result.settingsError) return "warning";
	if (result.scope === "global" && result.settingsWritten === false) return "warning";
	if (result.scope === "session" && result.settingsRestored === false) return "warning";
	return "info";
}

/** Unique option label: always includes provider/id. */
export function modelOptionLabel(model: AvailableModel): string {
	if (model.name && model.name !== model.id) {
		return `${model.name} · ${model.provider}/${model.id}`;
	}
	return `${model.provider}/${model.id}`;
}

async function pickScope(
	ui: StartupUi,
	preferred: ProfileScope,
	askScope: boolean,
): Promise<ProfileScope | undefined> {
	if (!askScope) return preferred;
	const preferredOrder =
		preferred === "global" ? [SCOPE_GLOBAL, SCOPE_SESSION] : [SCOPE_SESSION, SCOPE_GLOBAL];
	const scopeChoice = await (ui.selectScope ?? ui.select)("Apply scope", preferredOrder);
	if (scopeChoice === undefined) return undefined;
	return scopeChoice.startsWith("global") ? "global" : "session";
}

async function browseAllModels(
	ui: StartupUi,
	available: readonly AvailableModel[],
): Promise<AvailableModel | undefined> {
	if (available.length === 0) return undefined;

	const byProvider = new Map<string, AvailableModel[]>();
	for (const model of available) {
		const list = byProvider.get(model.provider) ?? [];
		list.push(model);
		byProvider.set(model.provider, list);
	}

	const providers = [...byProvider.keys()].sort((a, b) => a.localeCompare(b));
	const providerChoice = await ui.select("Browse models — provider", providers);
	if (providerChoice === undefined) return undefined;

	const models = [...(byProvider.get(providerChoice) ?? [])].sort((a, b) =>
		modelOptionLabel(a).localeCompare(modelOptionLabel(b)),
	);
	const items = models.map((model) => {
		const label = modelOptionLabel(model);
		const ref = `${model.provider}/${model.id}`;
		return {
			value: ref,
			label,
			searchText: `${model.id} ${model.provider} ${ref}${model.name ? ` ${model.name}` : ""}`,
		};
	});
	const modelChoice = ui.selectSearchable
		? await ui.selectSearchable(`Browse models — ${providerChoice}`, items, { cancelAction: "back" })
		: await ui.select(
				`Browse models — ${providerChoice}`,
				items.map((item) => item.label),
			);
	if (modelChoice === undefined) return undefined;

	// selectSearchable returns value (provider/id); plain select returns label.
	const byValue = models.find((model) => `${model.provider}/${model.id}` === modelChoice);
	if (byValue) return byValue;
	const labels = items.map((item) => item.label);
	const index = labels.indexOf(modelChoice);
	return index >= 0 ? models[index] : undefined;
}

async function applyManual(
	model: AvailableModel,
	scope: ProfileScope,
	deps: ApplyDeps,
	requestedThinking?: ThinkingLevel,
	source: "manual" | "current" = "manual",
): Promise<StartupPickerResult> {
	const ref = { provider: model.provider, id: model.id };
	const sessionSettings = scope === "session" ? prepareSessionSettings(deps) : undefined;
	if (sessionSettings && !sessionSettings.ok) {
		return { action: "cancelled", reason: sessionSettings.error };
	}

	const ok = await deps.setModel(ref);
	if (!ok) {
		return {
			action: "cancelled",
			reason: `No API key or model refused: ${ref.provider}/${ref.id}`,
		};
	}

	if (requestedThinking !== undefined) deps.setThinkingLevel(requestedThinking);
	const thinking = deps.getThinkingLevel();

	if (scope === "session") {
		const restored = await restoreSessionSettings(deps, sessionSettings!.snapshot);
		if (!restored.ok) {
			return {
				action: "applied",
				source,
				model: ref,
				thinking,
				scope: "session",
				settingsRestored: false,
				settingsError:
					restored.error ?? "Failed to restore the original settings.json state after session switch",
			};
		}
		return {
			action: "applied",
			source,
			model: ref,
			thinking,
			scope: "session",
			settingsRestored: true,
		};
	}

	if (!deps.writeSettingsDefaults) {
		return {
			action: "applied",
			source,
			model: ref,
			thinking,
			scope: "global",
			settingsWritten: false,
			settingsError: "Global apply is unavailable (no settings writer).",
		};
	}

	const written = deps.writeSettingsDefaults({
		defaultProvider: ref.provider,
		defaultModel: ref.id,
		defaultThinkingLevel: thinking,
	} satisfies SettingsDefaults);

	return {
		action: "applied",
		source,
		model: ref,
		thinking,
		scope: "global",
		settingsWritten: written.ok,
		settingsError: written.ok ? undefined : (written.error ?? "Failed to write settings.json"),
	};
}

/**
 * Startup /new short-list picker.
 * Order: keep current (first) → configured profiles → optional startup toggle → numbered Browse (last).
 */
export async function runStartupPicker(input: StartupPickerInput): Promise<StartupPickerResult> {
	if (!STARTUP_PICKER_REASONS.has(input.reason)) {
		return { action: "skipped", reason: `reason:${input.reason}` };
	}
	if (!input.hasUI) {
		return { action: "skipped", reason: "no-ui" };
	}
	if (!input.config.startup) {
		return { action: "skipped", reason: "startup-disabled" };
	}

	const available = input.getAvailable();
	const listedProfiles = input.config.profiles;
	if (listedProfiles.length === 0 && available.length === 0 && !input.currentModel) {
		return { action: "skipped", reason: "no-profiles-or-models" };
	}

	const keepLabel = input.reason === "new"
		? formatKeepCurrentLabel(input.currentModel, input.currentThinking)
		: formatKeepDefaultLabel(input.currentModel, input.currentThinking);
	const labels = listedProfiles.map((p) => profileLabel(p));
	let startupEnabled = true;

	const askScope = input.askScope !== false;
	while (true) {
		const options = [
			keepLabel,
			...labels,
			...(startupEnabled && input.disableStartup ? [DISABLE_STARTUP] : []),
			BROWSE_ALL,
		];
		const title = startupEnabled
			? "Startup model profile"
			: "Startup model profile · future startup off";
		const choice = await (input.ui.selectStartup ?? input.ui.select)(title, options);
		if (choice === undefined) {
			return { action: "cancelled", reason: "dismissed" };
		}
		if (choice === DISABLE_STARTUP) {
			if (input.disableStartup?.()) startupEnabled = false;
			continue;
		}
		if (choice === keepLabel) {
			if (input.reason !== "new" || !input.currentModel) {
				return { action: "cancelled", reason: "keep-current" };
			}
			return applyManual(
				{ provider: input.currentModel.provider, id: input.currentModel.id },
				"session",
				input.deps,
				input.currentThinking,
				"current",
			);
		}

		if (choice === BROWSE_ALL) {
			const picked = await browseAllModels(input.ui, available);
			if (!picked) {
				return { action: "cancelled", reason: "browse-cancelled" };
			}
			const levels = supportedThinkingLevels(picked);
			const thinking = await input.ui.select(
				"Thinking level",
				levels,
				levels.includes(input.currentThinking ?? "off") ? input.currentThinking : levels[0],
			) as ThinkingLevel | undefined;
			if (!thinking) continue;
			const scope = await pickScope(input.ui, input.config.startupScope, askScope);
			if (!scope) continue;
			return applyManual(picked, scope, input.deps, thinking);
		}

		const index = labels.indexOf(choice);
		const profile = index >= 0 ? listedProfiles[index] : undefined;
		if (!profile) {
			return { action: "cancelled", reason: "unknown-choice" };
		}

		const scope = await pickScope(input.ui, input.config.startupScope, askScope);
		if (!scope) continue;

		const result = await applyProfile(profile, scope, input.deps);
		return { action: "applied", source: "profile", profile, scope, result };
	}
}
