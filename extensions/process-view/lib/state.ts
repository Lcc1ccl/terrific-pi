import { stripVTControlCharacters } from "node:util";

import {
	PROCESS_ENTRY_TYPE,
	type ArtifactKind,
	type PersistedProcessState,
	type ProcessArtifact,
	type ProcessSnapshot,
	type ProcessStatus,
	type ProcessStep,
	type ProcessUpdateInput,
	type ProcessViewMode,
	type StepStatus,
} from "./types.ts";

const PROCESS_STATUSES = new Set<ProcessStatus>(["running", "waiting", "blocked", "completed", "interrupted"]);
const STEP_STATUSES = new Set<StepStatus>(["pending", "active", "done", "failed"]);
const ARTIFACT_KINDS = new Set<ArtifactKind>(["file", "test", "screenshot", "url", "commit", "report"]);
const VIEW_MODES = new Set<ProcessViewMode>(["compact", "full", "off"]);

export class ProcessUpdateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProcessUpdateError";
	}
}

export function sanitizeProcessText(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function requiredText(value: string, field: string, maxLength: number): string {
	const clean = sanitizeProcessText(value);
	if (!clean) throw new ProcessUpdateError(`${field} is required`);
	if (clean.length > maxLength) throw new ProcessUpdateError(`${field} is too long`);
	return clean;
}

function optionalText(value: string | undefined, field: string, maxLength: number): string | undefined {
	if (value === undefined) return undefined;
	const clean = sanitizeProcessText(value);
	if (!clean) return undefined;
	if (clean.length > maxLength) throw new ProcessUpdateError(`${field} is too long`);
	return clean;
}

function cloneSnapshot(snapshot: ProcessSnapshot): ProcessSnapshot {
	return {
		...snapshot,
		steps: snapshot.steps.map((step) => ({ ...step })),
		artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact })),
	};
}

function validateSemantics(snapshot: Pick<ProcessSnapshot, "status" | "steps" | "update" | "blocker" | "verification">): void {
	const active = snapshot.steps.filter((step) => step.status === "active").length;
	if (snapshot.status === "running" && active !== 1) {
		throw new ProcessUpdateError("Running requires exactly one active step");
	}
	if (snapshot.status === "waiting") {
		if (active > 1) throw new ProcessUpdateError("Waiting allows at most one active step");
		if (!snapshot.update) throw new ProcessUpdateError("Waiting requires update");
	}
	if (snapshot.status === "blocked" && !snapshot.blocker) {
		throw new ProcessUpdateError("Blocked requires blocker");
	}
	if (snapshot.status === "completed") {
		if (snapshot.steps.some((step) => step.status !== "done")) {
			throw new ProcessUpdateError("Completed requires all steps done");
		}
		if (!snapshot.update && !snapshot.verification) {
			throw new ProcessUpdateError("Completed requires update or verification");
		}
	}
}

export function normalizeProcessUpdate(
	input: ProcessUpdateInput,
	previous: ProcessSnapshot | undefined = undefined,
	now = Date.now(),
): ProcessSnapshot {
	if (input.steps.length < 1 || input.steps.length > 5) {
		throw new ProcessUpdateError("Process requires one to five steps");
	}
	if ((input.artifacts?.length ?? 0) > 5) {
		throw new ProcessUpdateError("Process allows at most five artifacts");
	}

	const steps: ProcessStep[] = input.steps.map((step, index) => ({
		text: requiredText(step.text, `Step ${index + 1}`, 100),
		status: step.status,
	}));
	const artifacts: ProcessArtifact[] = (input.artifacts ?? []).map((artifact, index) => ({
		kind: artifact.kind,
		label: requiredText(artifact.label, `Artifact ${index + 1}`, 80),
		...(optionalText(artifact.ref, `Artifact ${index + 1} ref`, 200) ? {
			ref: optionalText(artifact.ref, `Artifact ${index + 1} ref`, 200),
		} : {}),
	}));
	const snapshot: ProcessSnapshot = {
		version: 1,
		title: requiredText(input.title, "Title", 120),
		status: input.status,
		steps,
		update: optionalText(input.update, "Update", 180),
		blocker: optionalText(input.blocker, "Blocker", 240),
		verification: optionalText(input.verification, "Verification", 180),
		artifacts,
		startedAt: previous?.startedAt ?? now,
		updatedAt: now,
	};
	validateSemantics(snapshot);
	return snapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCleanText(value: unknown, maxLength: number, required: boolean): value is string {
	if (typeof value !== "string") return false;
	const clean = sanitizeProcessText(value);
	return clean === value && clean.length <= maxLength && (!required || clean.length > 0);
}

function isOptionalCleanText(value: unknown, maxLength: number): value is string | undefined {
	return value === undefined || isCleanText(value, maxLength, false);
}

function isStep(value: unknown): value is ProcessStep {
	return isRecord(value)
		&& isCleanText(value.text, 100, true)
		&& typeof value.status === "string"
		&& STEP_STATUSES.has(value.status as StepStatus);
}

function isArtifact(value: unknown): value is ProcessArtifact {
	return isRecord(value)
		&& typeof value.kind === "string"
		&& ARTIFACT_KINDS.has(value.kind as ArtifactKind)
		&& isCleanText(value.label, 80, true)
		&& isOptionalCleanText(value.ref, 200);
}

export function isProcessSnapshot(value: unknown): value is ProcessSnapshot {
	if (!isRecord(value)
		|| value.version !== 1
		|| !isCleanText(value.title, 120, true)
		|| typeof value.status !== "string"
		|| !PROCESS_STATUSES.has(value.status as ProcessStatus)
		|| !Array.isArray(value.steps)
		|| value.steps.length < 1
		|| value.steps.length > 5
		|| !value.steps.every(isStep)
		|| !isOptionalCleanText(value.update, 180)
		|| !isOptionalCleanText(value.blocker, 240)
		|| !isOptionalCleanText(value.verification, 180)
		|| !Array.isArray(value.artifacts)
		|| value.artifacts.length > 5
		|| !value.artifacts.every(isArtifact)
		|| !Number.isFinite(value.startedAt)
		|| !Number.isFinite(value.updatedAt)
		|| (value.updatedAt as number) < (value.startedAt as number)) {
		return false;
	}
	try {
		validateSemantics(value as unknown as ProcessSnapshot);
		return true;
	} catch {
		return (value as { status: ProcessStatus }).status === "interrupted";
	}
}

export function isPersistedProcessState(value: unknown): value is PersistedProcessState {
	if (!isRecord(value)
		|| value.version !== 1
		|| typeof value.viewMode !== "string"
		|| !VIEW_MODES.has(value.viewMode as ProcessViewMode)
		|| typeof value.cleared !== "boolean") {
		return false;
	}
	if (value.cleared && value.snapshot !== undefined) return false;
	return value.snapshot === undefined || isProcessSnapshot(value.snapshot);
}

export function createPersistedState(
	snapshot: ProcessSnapshot | undefined,
	viewMode: ProcessViewMode,
): PersistedProcessState {
	return {
		version: 1,
		viewMode,
		...(snapshot ? { snapshot: cloneSnapshot(snapshot) } : {}),
		cleared: false,
	};
}

export function createTombstone(viewMode: ProcessViewMode): PersistedProcessState {
	return { version: 1, viewMode, cleared: true };
}

export interface RestoreResult {
	state: PersistedProcessState;
	corrupted: boolean;
}

export function restoreProcessState(entries: readonly unknown[]): RestoreResult {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PROCESS_ENTRY_TYPE) continue;
		if (!isPersistedProcessState(entry.data)) {
			return { state: createTombstone("compact"), corrupted: true };
		}
		return {
			state: entry.data.snapshot
				? createPersistedState(entry.data.snapshot, entry.data.viewMode)
				: { ...entry.data },
			corrupted: false,
		};
	}
	return { state: createPersistedState(undefined, "compact"), corrupted: false };
}

export function settleSnapshot(snapshot: ProcessSnapshot, now = Date.now()): ProcessSnapshot {
	const next = cloneSnapshot(snapshot);
	if (next.status === "running") {
		next.status = "waiting";
		next.update ??= "Waiting for continuation";
		next.updatedAt = now;
	}
	return next;
}

export function interruptSnapshot(
	snapshot: ProcessSnapshot,
	reason: "aborted" | "error",
	now = Date.now(),
): ProcessSnapshot {
	if (snapshot.status === "completed") return cloneSnapshot(snapshot);
	return {
		...cloneSnapshot(snapshot),
		status: "interrupted",
		update: reason === "aborted" ? "Run interrupted" : "Run stopped after an error",
		updatedAt: now,
	};
}

export function buildContextReminder(snapshot: ProcessSnapshot): string {
	const steps = snapshot.steps
		.map((step) => `- [${step.status}] ${step.text}`)
		.join("\n");
	return [
		"<process-view-context>",
		`Task: ${snapshot.title}`,
		`Status: ${snapshot.status}`,
		"Steps:",
		steps,
		...(snapshot.blocker ? [`Blocker: ${snapshot.blocker}`] : []),
		"Continue from this state and publish process_update only at the next milestone.",
		"</process-view-context>",
	].join("\n");
}
