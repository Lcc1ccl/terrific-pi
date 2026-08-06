import type { ApplyResult, ModelProfile, ProfileScope, ThinkingLevel } from "./types.ts";
import type { SettingsDefaults, SettingsFileSnapshot } from "./settings-defaults.ts";

export interface ModelRef {
	provider: string;
	id: string;
}

export interface ApplyDeps {
	findModel: (provider: string, modelId: string) => ModelRef | undefined;
	setModel: (model: ModelRef) => Promise<boolean>;
	setThinkingLevel: (level: ThinkingLevel) => void;
	getThinkingLevel: () => ThinkingLevel;
	/** Capture the exact settings.json state before Pi persists a model switch. */
	snapshotSettingsFile?: () => SettingsFileSnapshot;
	/** Restore the exact state captured by snapshotSettingsFile. */
	restoreSettingsFile?: (
		snapshot: Extract<SettingsFileSnapshot, { ok: true }>,
	) => { ok: boolean; error?: string };
	writeSettingsDefaults?: (
		defaults: SettingsDefaults,
	) => { ok: boolean; error?: string };
}

type SessionSettingsSnapshot = Extract<SettingsFileSnapshot, { ok: true }>;

type SessionSettingsPreparation =
	| { ok: true; snapshot: SessionSettingsSnapshot }
	| { ok: false; error: string };

export function prepareSessionSettings(deps: ApplyDeps): SessionSettingsPreparation {
	if (!deps.snapshotSettingsFile || !deps.restoreSettingsFile) {
		return { ok: false, error: "Session apply is unavailable: settings snapshot support is not configured." };
	}
	const snapshot = deps.snapshotSettingsFile();
	if (!snapshot.ok) {
		return { ok: false, error: `Session apply is unavailable: ${snapshot.error}` };
	}
	return { ok: true, snapshot };
}

export async function restoreSessionSettings(
	deps: ApplyDeps,
	snapshot: SessionSettingsSnapshot,
): Promise<{ ok: boolean; error?: string }> {
	// Pi exposes no settings flush API; its writes are queued on microtasks.
	await new Promise<void>((resolve) => setImmediate(resolve));
	try {
		const restored = deps.restoreSettingsFile?.(snapshot);
		if (!restored) return { ok: false, error: "Session switched, but no settings restorer is configured." };
		return restored.ok ? { ok: true } : { ok: false, error: restored.error };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Apply a profile to the current session, optionally also writing global defaults.
 *
 * Important: pi's `setModel` / `setThinkingLevel` always update settings.json defaults.
 * For scope=session we snapshot defaults, switch the session, then restore the snapshot
 * so /new keeps the configured default model.
 */
export async function applyProfile(
	profile: ModelProfile,
	scope: ProfileScope,
	deps: ApplyDeps,
): Promise<ApplyResult> {
	const model = deps.findModel(profile.provider, profile.model);
	if (!model) {
		return {
			ok: false,
			kind: "unknown-model",
			reason: `Model not found: ${profile.provider}/${profile.model}`,
		};
	}

	const sessionSettings = scope === "session" ? prepareSessionSettings(deps) : undefined;
	if (sessionSettings && !sessionSettings.ok) {
		return {
			ok: false,
			kind: "settings-snapshot-failed",
			reason: sessionSettings.error,
		};
	}

	const ok = await deps.setModel(model);
	if (!ok) {
		return {
			ok: false,
			kind: "set-model-refused",
			reason: `No API key or model refused: ${profile.provider}/${profile.model}`,
		};
	}

	deps.setThinkingLevel(profile.thinking);
	const thinking = deps.getThinkingLevel();
	const thinkingClamped = thinking !== profile.thinking;

	if (scope === "session") {
		const restored = await restoreSessionSettings(deps, sessionSettings!.snapshot);
		if (!restored.ok) {
			return {
				ok: true,
				profile,
				scope: "session",
				thinking,
				thinkingClamped,
				settingsRestored: false,
				settingsError:
					restored.error ??
					"Session switched, but failed to restore the original settings.json state.",
			};
		}

		return {
			ok: true,
			profile,
			scope: "session",
			thinking,
			thinkingClamped,
			settingsRestored: true,
		};
	}

	if (!deps.writeSettingsDefaults) {
		return {
			ok: false,
			kind: "settings-write-failed",
			reason: "Global apply is unavailable (no settings writer).",
		};
	}

	const written = deps.writeSettingsDefaults({
		defaultProvider: profile.provider,
		defaultModel: profile.model,
		defaultThinkingLevel: thinking,
	});

	if (!written.ok) {
		return {
			ok: true,
			profile,
			scope: "global",
			thinking,
			thinkingClamped,
			settingsWritten: false,
			settingsError: written.error ?? "Failed to write settings.json defaults",
		};
	}

	return {
		ok: true,
		profile,
		scope: "global",
		thinking,
		thinkingClamped,
		settingsWritten: true,
	};
}

export function formatApplySuccess(result: Extract<ApplyResult, { ok: true }>): string {
	const base = `Profile "${result.profile.id}" (${result.profile.alias}): ${result.profile.provider}/${result.profile.model} · ${result.thinking} (${result.scope})`;
	const lines = [base];
	if (result.thinkingClamped) {
		lines.push(`Requested thinking "${result.profile.thinking}", applied "${result.thinking}".`);
	}
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

export function applyResultLevel(result: Extract<ApplyResult, { ok: true }>): "info" | "warning" {
	if (result.settingsError) return "warning";
	if (result.scope === "global" && result.settingsWritten === false) return "warning";
	if (result.scope === "session" && result.settingsRestored === false) return "warning";
	return "info";
}
