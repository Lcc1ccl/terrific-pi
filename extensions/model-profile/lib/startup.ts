import type { ApplyResult, ModelProfile, ModelProfileConfig, ProfileScope, ThinkingLevel } from "./types.ts";
import { profileLabel } from "./config.ts";
import {
	applyProfile,
	type ApplyDeps,
	type ModelRef,
} from "./apply.ts";
import { profileMatches } from "./match.ts";
import { snapshotToRestoreDefaults, type SettingsDefaults } from "./settings-defaults.ts";

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
			source: "manual";
			model: ModelRef;
			thinking: ThinkingLevel;
			scope: ProfileScope;
			settingsWritten?: boolean;
			settingsRestored?: boolean;
			settingsError?: string;
	  };

export interface StartupUi {
	select: (title: string, options: string[]) => Promise<string | undefined>;
}

export interface AvailableModel {
	provider: string;
	id: string;
	name?: string;
}

export interface StartupPickerInput {
	reason: SessionStartReason;
	hasUI: boolean;
	config: ModelProfileConfig;
	deps: ApplyDeps;
	ui: StartupUi;
	/** Already-activated session model when the picker opens. */
	currentModel?: ModelRef | null;
	currentThinking?: ThinkingLevel;
	/** Full registry of available models (auth-ready). */
	getAvailable: () => readonly AvailableModel[];
	/** When true, after a pick also ask session vs global. Default true. */
	askScope?: boolean;
}

const SCOPE_SESSION = "session — this chat only";
const SCOPE_GLOBAL = "global — also update defaults";
const BROWSE_ALL = "Browse all models…";

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

export function formatManualApplyMessage(
	result: Extract<StartupPickerResult, { source: "manual" }>,
): string {
	const base = `Manual: ${result.model.provider}/${result.model.id} · ${result.thinking} (${result.scope})`;
	const lines = [base];
	if (result.scope === "global") {
		if (result.settingsWritten) {
			lines.push("Updated settings.json defaults (provider/model/thinking).");
		} else if (result.settingsError) {
			lines.push(`Session applied, but settings write failed: ${result.settingsError}`);
		}
	} else {
		if (result.settingsRestored) {
			lines.push("Restored previous settings.json defaults (session-only).");
		}
		if (result.settingsError) {
			lines.push(result.settingsError);
		}
	}
	return lines.join("\n");
}

export function manualResultLevel(
	result: Extract<StartupPickerResult, { source: "manual" }>,
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
	const scopeChoice = await ui.select("Apply scope", preferredOrder);
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
	const labels = models.map(modelOptionLabel);
	const modelChoice = await ui.select(`Browse models — ${providerChoice}`, labels);
	if (modelChoice === undefined) return undefined;

	const index = labels.indexOf(modelChoice);
	return index >= 0 ? models[index] : undefined;
}

async function applyManual(
	model: AvailableModel,
	scope: ProfileScope,
	deps: ApplyDeps,
): Promise<StartupPickerResult> {
	const ref = { provider: model.provider, id: model.id };
	const thinkingBefore = deps.getThinkingLevel();
	const defaultsSnapshot =
		scope === "session" ? deps.readSettingsDefaults?.() : undefined;

	const ok = await deps.setModel(ref);
	if (!ok) {
		return {
			action: "cancelled",
			reason: `No API key or model refused: ${ref.provider}/${ref.id}`,
		};
	}

	const thinking = deps.getThinkingLevel();

	if (scope === "session") {
		if (!defaultsSnapshot || !deps.writeSettingsDefaults) {
			return {
				action: "applied",
				source: "manual",
				model: ref,
				thinking,
				scope: "session",
				settingsRestored: false,
				settingsError:
					"Session switched, but could not snapshot settings defaults — session-only is not guaranteed (pi persists on setModel).",
			};
		}

		const { defaults, usedThinkingFallback } = snapshotToRestoreDefaults(
			defaultsSnapshot,
			thinkingBefore,
		);
		const restored = deps.writeSettingsDefaults(defaults);
		const warnings: string[] = [];
		if (!restored.ok) {
			return {
				action: "applied",
				source: "manual",
				model: ref,
				thinking,
				scope: "session",
				settingsRestored: false,
				settingsError:
					restored.error ?? "Failed to restore settings defaults after session switch",
			};
		}
		if (defaultsSnapshot.incomplete || usedThinkingFallback) {
			warnings.push(
				"Settings defaults were incomplete; restored provider/model and used previous session thinking for defaultThinkingLevel.",
			);
		}
		return {
			action: "applied",
			source: "manual",
			model: ref,
			thinking,
			scope: "session",
			settingsRestored: true,
			settingsError: warnings.length > 0 ? warnings.join(" ") : undefined,
		};
	}

	if (!deps.writeSettingsDefaults) {
		return {
			action: "applied",
			source: "manual",
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
		source: "manual",
		model: ref,
		thinking,
		scope: "global",
		settingsWritten: written.ok,
		settingsError: written.ok ? undefined : (written.error ?? "Failed to write settings.json"),
	};
}

/**
 * Profiles offered in the picker: drop any that already match the activated
 * session (typically the `default` profile), so Keep replaces that redundant row.
 */
export function profilesForStartupList(
	profiles: readonly ModelProfile[],
	currentModel: ModelRef | null | undefined,
	currentThinking: ThinkingLevel | undefined,
): ModelProfile[] {
	if (!currentModel || currentThinking === undefined) {
		return [...profiles];
	}
	return profiles.filter((profile) => !profileMatches(profile, currentModel, currentThinking));
}

/**
 * Startup /new short-list picker.
 * Order: keep current session (first) → other profiles → browse all models (last).
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
	const listedProfiles = profilesForStartupList(
		input.config.profiles,
		input.currentModel,
		input.currentThinking,
	);
	if (listedProfiles.length === 0 && available.length === 0 && !input.currentModel) {
		return { action: "skipped", reason: "no-profiles-or-models" };
	}

	const keepLabel = formatKeepCurrentLabel(input.currentModel, input.currentThinking);
	const labels = listedProfiles.map((p) => profileLabel(p));
	const options = [keepLabel, ...labels, BROWSE_ALL];

	const choice = await input.ui.select("Startup model profile", options);
	if (choice === undefined) {
		return { action: "cancelled", reason: "dismissed" };
	}
	if (choice === keepLabel) {
		return { action: "cancelled", reason: "keep-current" };
	}

	const askScope = input.askScope !== false;

	if (choice === BROWSE_ALL) {
		const picked = await browseAllModels(input.ui, available);
		if (!picked) {
			return { action: "cancelled", reason: "browse-cancelled" };
		}
		const scope = await pickScope(input.ui, input.config.startupScope, askScope);
		if (!scope) {
			return { action: "cancelled", reason: "scope-dismissed" };
		}
		return applyManual(picked, scope, input.deps);
	}

	const index = labels.indexOf(choice);
	const profile = index >= 0 ? listedProfiles[index] : undefined;
	if (!profile) {
		return { action: "cancelled", reason: "unknown-choice" };
	}

	const scope = await pickScope(input.ui, input.config.startupScope, askScope);
	if (!scope) {
		return { action: "cancelled", reason: "scope-dismissed" };
	}

	const result = await applyProfile(profile, scope, input.deps);
	return { action: "applied", source: "profile", profile, scope, result };
}
