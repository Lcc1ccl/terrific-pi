export const PILOT_ACTIVATION_ENTRY_TYPE = "terrific-pi:pilot:activation-v1";

export interface PilotActivationState {
	modePolicy: "edit";
	manualPilotActive: boolean;
}

export interface PilotActivationEntry extends PilotActivationState {
	version: 1;
}

export type PilotActivationSource = "manual" | "inactive";
export type ActivationResult =
	| { ok: true; state: PilotActivationState }
	| { ok: false; reason: string };

type LegacyPilotMode = "ask" | "plan" | "edit" | "auto";

function inactive(): PilotActivationState {
	return { modePolicy: "edit", manualPilotActive: false };
}

function normalize(state: PilotActivationState): PilotActivationState {
	return { modePolicy: "edit", manualPilotActive: state.manualPilotActive };
}

export function isPilotActive(state: PilotActivationState): boolean {
	return state.manualPilotActive;
}

export function activationSource(state: PilotActivationState): PilotActivationSource {
	return state.manualPilotActive ? "manual" : "inactive";
}

export function activateManualPilot(_state: PilotActivationState): ActivationResult {
	return { ok: true, state: { modePolicy: "edit", manualPilotActive: true } };
}

export function deactivateManualPilot(state: PilotActivationState, options: { safe: boolean }): ActivationResult {
	if (!state.manualPilotActive) return { ok: true, state: inactive() };
	if (!options.safe) return { ok: false, reason: "Pilot is active; wait or cancel before deactivating it." };
	return { ok: true, state: inactive() };
}

export function toActivationEntry(state: PilotActivationState): PilotActivationEntry {
	return { version: 1, ...normalize(state) };
}

function legacyMode(value: unknown): value is LegacyPilotMode {
	return value === "ask" || value === "plan" || value === "edit" || value === "auto";
}

function legacyEntry(value: unknown): { version: 1; modePolicy: LegacyPilotMode; manualPilotActive: boolean } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || !legacyMode(record.modePolicy) || typeof record.manualPilotActive !== "boolean") return undefined;
	return { version: 1, modePolicy: record.modePolicy, manualPilotActive: record.manualPilotActive };
}

export function restoreActivationState(
	entries: readonly unknown[],
	fallback: PilotActivationState,
): PilotActivationState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || record.customType !== PILOT_ACTIVATION_ENTRY_TYPE) continue;
		const data = legacyEntry(record.data);
		if (!data) continue;
		if (data.modePolicy === "auto") return inactive();
		return { modePolicy: "edit", manualPilotActive: data.manualPilotActive };
	}
	return normalize(fallback);
}
