import type { ApplyResult, ModelProfile, ProfileScope, ThinkingLevel } from "./types.ts";
import type { SettingsDefaults, SettingsDefaultsSnapshot } from "./settings-defaults.ts";
import { snapshotToRestoreDefaults } from "./settings-defaults.ts";

export interface ModelRef {
	provider: string;
	id: string;
}

export interface ApplyDeps {
	findModel: (provider: string, modelId: string) => ModelRef | undefined;
	setModel: (model: ModelRef) => Promise<boolean>;
	setThinkingLevel: (level: ThinkingLevel) => void;
	getThinkingLevel: () => ThinkingLevel;
	/**
	 * Snapshot settings defaults before setModel.
	 * Needed because pi's setModel/setThinkingLevel always persist globals.
	 */
	readSettingsDefaults?: () => SettingsDefaultsSnapshot | undefined;
	writeSettingsDefaults?: (
		defaults: SettingsDefaults,
	) => { ok: boolean; error?: string };
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

	const thinkingBefore = deps.getThinkingLevel();
	const defaultsSnapshot =
		scope === "session" ? deps.readSettingsDefaults?.() : undefined;

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
		if (!defaultsSnapshot || !deps.writeSettingsDefaults) {
			return {
				ok: true,
				profile,
				scope: "session",
				thinking,
				thinkingClamped,
				settingsRestored: false,
				settingsError:
					"Session switched, but could not snapshot settings defaults — session-only is not guaranteed (pi persists on setModel). Prefer /profile <id> global only when you intend to change defaults; avoid official /model if you need sticky defaults.",
			};
		}

		const { defaults, usedThinkingFallback } = snapshotToRestoreDefaults(
			defaultsSnapshot,
			thinkingBefore,
		);
		const restored = deps.writeSettingsDefaults(defaults);
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
					"Session switched, but failed to restore previous settings defaults (pi persists on setModel)",
			};
		}

		const warnings: string[] = [];
		if (defaultsSnapshot.incomplete || usedThinkingFallback) {
			warnings.push(
				"Settings defaults were incomplete; restored provider/model and used previous session thinking for defaultThinkingLevel.",
			);
		}

		return {
			ok: true,
			profile,
			scope: "session",
			thinking,
			thinkingClamped,
			settingsRestored: true,
			settingsError: warnings.length > 0 ? warnings.join(" ") : undefined,
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
			lines.push("Restored previous settings.json defaults (session-only).");
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
