export type PilotMode = "ask" | "plan" | "edit" | "auto";
export type PilotActivationSource = "auto" | "manual" | "inactive";

export const PILOT_ACTIVATION_ENTRY_TYPE = "terrific-pi:pilot:activation-v1";

export interface PilotActivationState {
	modePolicy: PilotMode;
	manualPilotActive: boolean;
}

export interface PilotActivationEntry extends PilotActivationState {
	version: 1;
}

export type ActivationResult =
	| { ok: true; state: PilotActivationState }
	| { ok: false; reason: string };

export function isPilotMode(value: unknown): value is PilotMode {
	return value === "ask" || value === "plan" || value === "edit" || value === "auto";
}

function normalize(state: PilotActivationState): PilotActivationState {
	return {
		modePolicy: state.modePolicy,
		manualPilotActive: state.modePolicy === "auto" ? false : state.manualPilotActive,
	};
}

export function isPilotActive(state: PilotActivationState): boolean {
	return state.modePolicy === "auto" || state.manualPilotActive;
}

export function activationSource(state: PilotActivationState): PilotActivationSource {
	if (state.modePolicy === "auto") return "auto";
	return state.manualPilotActive ? "manual" : "inactive";
}

export function activateManualPilot(state: PilotActivationState): ActivationResult {
	return { ok: true, state: state.modePolicy === "auto" ? normalize(state) : { ...state, manualPilotActive: true } };
}

export function deactivateManualPilot(state: PilotActivationState, options: { safe: boolean }): ActivationResult {
	if (state.modePolicy === "auto") {
		return { ok: false, reason: "AUTO is always active; switch to ask, plan, or edit first." };
	}
	if (!state.manualPilotActive) return { ok: true, state: normalize(state) };
	if (!options.safe) {
		return { ok: false, reason: "Pilot is active; wait, pause, or cancel before deactivating it." };
	}
	return { ok: true, state: { ...state, manualPilotActive: false } };
}

export function changeModePolicy(
	state: PilotActivationState,
	next: PilotMode,
	options: { safeToLeaveAuto: boolean },
): ActivationResult {
	if (state.modePolicy === "auto" && next !== "auto" && !options.safeToLeaveAuto) {
		return { ok: false, reason: "Pilot is active; wait, pause, or cancel before leaving AUTO." };
	}
	return {
		ok: true,
		state: normalize({
			modePolicy: next,
			manualPilotActive: next === "auto" ? false : state.manualPilotActive,
		}),
	};
}

export function toActivationEntry(state: PilotActivationState): PilotActivationEntry {
	return { version: 1, ...normalize(state) };
}

function isActivationEntry(value: unknown): value is PilotActivationEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.version === 1 && isPilotMode(record.modePolicy) && typeof record.manualPilotActive === "boolean";
}

export function restoreActivationState(
	entries: readonly unknown[],
	fallback: PilotActivationState,
): PilotActivationState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || record.customType !== PILOT_ACTIVATION_ENTRY_TYPE || !isActivationEntry(record.data)) continue;
		return normalize(record.data);
	}
	return normalize(fallback);
}
