import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import {
	TASKBOARD_ENTRY_TYPE,
	type ArtifactKind,
	type PersistedTaskboardState,
	type ProcessArtifact,
	type ProcessSnapshot,
	type ProcessStatus,
	type ProcessStep,
	type ProcessStepTelemetry,
	type ProcessTelemetry,
	type ProcessUpdateInput,
	type ProcessUsage,
	type TaskboardViewMode,
	type StepStatus,
} from "./types.ts";

const PROCESS_STATUSES = new Set<ProcessStatus>(["running", "waiting", "blocked", "completed", "interrupted"]);
const STEP_STATUSES = new Set<StepStatus>(["pending", "active", "done", "failed"]);
const ARTIFACT_KINDS = new Set<ArtifactKind>(["file", "test", "screenshot", "url", "commit", "report"]);
const VIEW_MODES = new Set<TaskboardViewMode>(["compact", "full", "off"]);
const MAX_TRACKED_MODELS = 8;
const STEP_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

const PROCESS_UPDATE_ERROR_PREFIX = "Taskboard validation: ";

export function isProcessUpdateErrorMessage(value: unknown): boolean {
	return typeof value === "string" && value.startsWith(PROCESS_UPDATE_ERROR_PREFIX);
}

export class ProcessUpdateError extends Error {
	constructor(message: string) {
		super(`${PROCESS_UPDATE_ERROR_PREFIX}${message}`);
		this.name = "ProcessUpdateError";
	}
}

interface StepIdentity {
	id?: string;
	text: string;
}

function isStepId(value: unknown): value is string {
	return typeof value === "string" && STEP_ID_PATTERN.test(value);
}

function nextStepId(used: Set<string>): string {
	let id = randomUUID();
	while (used.has(id)) id = randomUUID();
	used.add(id);
	return id;
}

function reconcileStepIndexes(
	previousSteps: readonly StepIdentity[],
	nextSteps: readonly StepIdentity[],
): number[] {
	const matches = Array.from({ length: nextSteps.length }, () => -1);
	const used = new Set<number>();
	const previousIds = new Map<string, number>();
	const duplicateIds = new Set<string>();
	for (let index = 0; index < previousSteps.length; index += 1) {
		const id = previousSteps[index]?.id;
		if (!id) continue;
		if (previousIds.has(id)) duplicateIds.add(id);
		else previousIds.set(id, index);
	}
	for (let index = 0; index < nextSteps.length; index += 1) {
		const id = nextSteps[index]?.id;
		const source = id && !duplicateIds.has(id) ? previousIds.get(id) : undefined;
		if (source === undefined || used.has(source)) continue;
		matches[index] = source;
		used.add(source);
	}

	const previousTextCounts = new Map<string, number>();
	const nextTextCounts = new Map<string, number>();
	for (let index = 0; index < previousSteps.length; index += 1) {
		if (used.has(index)) continue;
		const text = previousSteps[index]!.text;
		previousTextCounts.set(text, (previousTextCounts.get(text) ?? 0) + 1);
	}
	for (let index = 0; index < nextSteps.length; index += 1) {
		if (matches[index] !== -1) continue;
		const text = nextSteps[index]!.text;
		nextTextCounts.set(text, (nextTextCounts.get(text) ?? 0) + 1);
	}
	for (let index = 0; index < nextSteps.length; index += 1) {
		if (matches[index] !== -1) continue;
		const text = nextSteps[index]!.text;
		if (previousTextCounts.get(text) !== 1 || nextTextCounts.get(text) !== 1) continue;
		const source = previousSteps.findIndex((step, candidate) => !used.has(candidate) && step.text === text);
		if (source < 0) continue;
		matches[index] = source;
		used.add(source);
	}

	const remainingPrevious = previousSteps.map((_, index) => index).filter((index) => !used.has(index));
	const remainingNext = nextSteps.map((_, index) => index).filter((index) => matches[index] === -1);
	if (remainingPrevious.length === 1 && remainingNext.length === 1 && remainingPrevious[0] === remainingNext[0]) {
		matches[remainingNext[0]!] = remainingPrevious[0]!;
	}
	return matches;
}

function assignStepIds(previousSteps: readonly ProcessStep[], nextSteps: readonly ProcessStep[]): ProcessStep[] {
	const used = new Set(previousSteps.map((step) => step.id).filter(isStepId));
	const previous = previousSteps.map((step) => ({ ...step, id: step.id ?? nextStepId(used) }));
	const matches = reconcileStepIndexes(previous, nextSteps);
	return nextSteps.map((step, index) => ({
		...step,
		id: previous[matches[index] ?? -1]?.id ?? nextStepId(used),
	}));
}

export function sanitizeProcessText(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function emptyUsage(): ProcessUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function cloneUsage(usage: ProcessUsage): ProcessUsage {
	return { ...usage };
}

function emptyTelemetry(): ProcessTelemetry {
	return { turns: 0, usage: emptyUsage(), models: [], steps: [] };
}

function cloneTelemetry(telemetry: ProcessTelemetry): ProcessTelemetry {
	return {
		turns: telemetry.turns,
		usage: cloneUsage(telemetry.usage),
		models: [...telemetry.models],
		steps: telemetry.steps.map((step) => ({
			...step,
			usage: cloneUsage(step.usage),
			models: [...step.models],
		})),
	};
}

function emptyStepTelemetry(text: string, id?: string): ProcessStepTelemetry {
	return { ...(id ? { id } : {}), text, activeMs: 0, turns: 0, usage: emptyUsage(), models: [] };
}

function appendModel(models: string[], model: string | undefined): void {
	if (!model || models.includes(model)) return;
	if (models.length === MAX_TRACKED_MODELS) models.shift();
	models.push(model);
}

function nonnegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addUsage(target: ProcessUsage, source: Partial<ProcessUsage>): void {
	target.input += nonnegative(source.input);
	target.output += nonnegative(source.output);
	target.cacheRead += nonnegative(source.cacheRead);
	target.cacheWrite += nonnegative(source.cacheWrite);
	target.cost += nonnegative(source.cost);
}

export function stepElapsedMs(step: ProcessStepTelemetry | undefined, now = Date.now()): number | undefined {
	if (!step) return undefined;
	return step.activeMs + (step.activeSince === undefined ? 0 : Math.max(0, now - step.activeSince));
}

export function syncProcessTelemetry(
	previousSnapshot: ProcessSnapshot | undefined,
	previousTelemetry: ProcessTelemetry | undefined,
	nextSnapshot: ProcessSnapshot,
	now = Date.now(),
): ProcessTelemetry {
	const previous = previousTelemetry ? cloneTelemetry(previousTelemetry) : emptyTelemetry();
	const previousSteps = previous.steps.map((step, index) => ({
		...step,
		id: step.id ?? previousSnapshot?.steps[index]?.id,
	}));
	const hasStableIds = nextSnapshot.steps.every((step) => step.id)
		&& previousSteps.every((step) => step.id);
	const sourceIndexes = hasStableIds
		? nextSnapshot.steps.map((step) => previousSteps.findIndex((candidate) => candidate.id === step.id))
		: reconcileStepIndexes(previousSteps, nextSnapshot.steps);
	const steps = nextSnapshot.steps.map((step, index) => {
		const source = previous.steps[sourceIndexes[index] ?? -1];
		return source
			? {
				...source,
				...(step.id ?? source.id ? { id: step.id ?? source.id } : {}),
				text: step.text,
				usage: cloneUsage(source.usage),
				models: [...source.models],
			}
			: emptyStepTelemetry(step.text, step.id);
	});
	const previousActive = previousSnapshot?.status === "running"
		? previousSnapshot.steps.findIndex((step) => step.status === "active")
		: -1;
	const nextActive = nextSnapshot.status === "running"
		? nextSnapshot.steps.findIndex((step) => step.status === "active")
		: -1;

	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index]!;
		const continuing = index === nextActive
			&& sourceIndexes[index] === previousActive
			&& previousActive >= 0
			&& step.activeSince !== undefined;
		if (step.activeSince !== undefined && !continuing) {
			step.activeMs += Math.max(0, now - step.activeSince);
			delete step.activeSince;
		}
	}
	if (nextActive >= 0 && steps[nextActive]!.activeSince === undefined) {
		steps[nextActive]!.activeSince = now;
	}
	if (!previousSnapshot && previous.steps.length === 0 && previous.turns > 0 && nextActive >= 0) {
		const active = steps[nextActive]!;
		active.turns += previous.turns;
		addUsage(active.usage, previous.usage);
		for (const model of previous.models) appendModel(active.models, model);
	}

	return { ...previous, steps };
}

interface AssistantUsageLike {
	provider?: string;
	model?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
}

export function recordAssistantUsage(
	telemetry: ProcessTelemetry | undefined,
	snapshot: ProcessSnapshot | undefined,
	message: AssistantUsageLike,
): ProcessTelemetry {
	const next = telemetry ? cloneTelemetry(telemetry) : emptyTelemetry();
	const model = message.provider && message.model
		? sanitizeProcessText(`${message.provider}/${message.model}`).slice(0, 160)
		: undefined;
	const usage: Partial<ProcessUsage> = {
		input: message.usage?.input,
		output: message.usage?.output,
		cacheRead: message.usage?.cacheRead,
		cacheWrite: message.usage?.cacheWrite,
		cost: message.usage?.cost?.total,
	};
	next.turns += 1;
	addUsage(next.usage, usage);
	appendModel(next.models, model);

	const activeIndex = snapshot?.steps.findIndex((step) => step.status === "active") ?? -1;
	const active = next.steps[activeIndex];
	if (active) {
		active.turns += 1;
		addUsage(active.usage, usage);
		appendModel(active.models, model);
	}
	return next;
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

export function semanticProcessEqual(
	left: ProcessSnapshot | undefined,
	right: ProcessSnapshot | undefined,
): boolean {
	if (!left || !right) return left === right;
	const facts = (snapshot: ProcessSnapshot) => ({
		version: snapshot.version,
		title: snapshot.title,
		status: snapshot.status,
		steps: snapshot.steps.map(({ text, status }) => ({ text, status })),
		update: snapshot.update,
		blocker: snapshot.blocker,
		verification: snapshot.verification,
		artifacts: snapshot.artifacts,
	});
	return JSON.stringify(facts(left)) === JSON.stringify(facts(right));
}

function validateTransitions(previous: ProcessSnapshot | undefined, next: ProcessSnapshot): void {
	if (!previous) return;
	if (previous.status === "completed" && !semanticProcessEqual(previous, next)) {
		throw new ProcessUpdateError("Completed is terminal for the current request; start a new user request for new work");
	}
	const previousById = new Map(previous.steps.filter((step) => step.id).map((step) => [step.id!, step]));
	for (const step of next.steps) {
		const prior = step.id ? previousById.get(step.id) : undefined;
		if (prior?.status === "done" && (step.status === "pending" || step.status === "active")) {
			throw new ProcessUpdateError(`Step "${step.text}" is done and cannot transition to ${step.status}; add a new step for new work`);
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

	const rawSteps: ProcessStep[] = input.steps.map((step, index) => ({
		text: requiredText(step.text, `Step ${index + 1}`, 100),
		status: step.status,
	}));
	const steps = assignStepIds(previous?.steps ?? [], rawSteps);
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
	validateTransitions(previous, snapshot);
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
		&& (value.id === undefined || isStepId(value.id))
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

function isNonnegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsage(value: unknown): value is ProcessUsage {
	return isRecord(value)
		&& isNonnegativeNumber(value.input)
		&& isNonnegativeNumber(value.output)
		&& isNonnegativeNumber(value.cacheRead)
		&& isNonnegativeNumber(value.cacheWrite)
		&& isNonnegativeNumber(value.cost);
}

export function isProcessTelemetry(value: unknown, snapshot: ProcessSnapshot): value is ProcessTelemetry {
	if (!isRecord(value)
		|| !Number.isInteger(value.turns)
		|| !isNonnegativeNumber(value.turns)
		|| !isUsage(value.usage)
		|| !Array.isArray(value.models)
		|| value.models.length > MAX_TRACKED_MODELS
		|| !value.models.every((model) => isCleanText(model, 160, true))
		|| !Array.isArray(value.steps)
		|| value.steps.length !== snapshot.steps.length) {
		return false;
	}
	let activeTimers = 0;
	const telemetryIds = new Set<string>();
	for (let index = 0; index < value.steps.length; index += 1) {
		const step = value.steps[index];
		const snapshotStep = snapshot.steps[index];
		if (!isRecord(step)
			|| (step.id !== undefined && !isStepId(step.id))
			|| (step.id !== undefined && telemetryIds.has(step.id))
			|| (step.id !== undefined && snapshotStep?.id !== undefined && step.id !== snapshotStep.id)
			|| step.text !== snapshotStep?.text
			|| !isNonnegativeNumber(step.activeMs)
			|| (step.activeSince !== undefined && !isNonnegativeNumber(step.activeSince))
			|| !Number.isInteger(step.turns)
			|| !isNonnegativeNumber(step.turns)
			|| !isUsage(step.usage)
			|| !Array.isArray(step.models)
			|| step.models.length > MAX_TRACKED_MODELS
			|| !step.models.every((model) => isCleanText(model, 160, true))) {
			return false;
		}
		if (step.id !== undefined) telemetryIds.add(step.id);
		if (step.activeSince !== undefined) {
			activeTimers += 1;
			if (snapshot.status !== "running" || snapshot.steps[index]?.status !== "active") return false;
		}
	}
	return activeTimers <= 1;
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
		const ids = (value.steps as ProcessStep[]).map((step) => step.id).filter(isStepId);
		if (new Set(ids).size !== ids.length) return false;
		validateSemantics(value as unknown as ProcessSnapshot);
		return true;
	} catch {
		return (value as { status: ProcessStatus }).status === "interrupted";
	}
}

export function isPersistedTaskboardState(value: unknown): value is PersistedTaskboardState {
	if (!isRecord(value)
		|| value.version !== 1
		|| typeof value.viewMode !== "string"
		|| !VIEW_MODES.has(value.viewMode as TaskboardViewMode)
		|| typeof value.cleared !== "boolean") {
		return false;
	}
	if (value.cleared) return value.snapshot === undefined && value.telemetry === undefined;
	if (value.snapshot === undefined) return value.telemetry === undefined;
	if (!isProcessSnapshot(value.snapshot)) return false;
	return value.telemetry === undefined || isProcessTelemetry(value.telemetry, value.snapshot);
}

function withInternalStepIds(
	snapshot: ProcessSnapshot,
	telemetry?: ProcessTelemetry,
): { snapshot: ProcessSnapshot; telemetry?: ProcessTelemetry } {
	const used = new Set(snapshot.steps.map((step) => step.id).filter(isStepId));
	const steps = snapshot.steps.map((step, index) => {
		if (step.id) return { ...step };
		const telemetryId = telemetry?.steps[index]?.id;
		if (telemetryId && !used.has(telemetryId)) {
			used.add(telemetryId);
			return { ...step, id: telemetryId };
		}
		return { ...step, id: nextStepId(used) };
	});
	const migratedSnapshot = { ...cloneSnapshot(snapshot), steps };
	if (!telemetry) return { snapshot: migratedSnapshot };
	return {
		snapshot: migratedSnapshot,
		telemetry: {
			...cloneTelemetry(telemetry),
			steps: telemetry.steps.map((step, index) => ({
				...step,
				id: steps[index]?.id,
				text: steps[index]?.text ?? step.text,
				usage: cloneUsage(step.usage),
				models: [...step.models],
			})),
		},
	};
}

export function createPersistedState(
	snapshot: ProcessSnapshot | undefined,
	viewMode: TaskboardViewMode,
	telemetry?: ProcessTelemetry,
): PersistedTaskboardState {
	const migrated = snapshot ? withInternalStepIds(snapshot, telemetry) : undefined;
	return {
		version: 1,
		viewMode,
		...(migrated ? { snapshot: migrated.snapshot } : {}),
		...(migrated?.telemetry ? { telemetry: migrated.telemetry } : {}),
		cleared: false,
	};
}

export function createTombstone(viewMode: TaskboardViewMode): PersistedTaskboardState {
	return { version: 1, viewMode, cleared: true };
}

export interface RestoreResult {
	state: PersistedTaskboardState;
	corrupted: boolean;
	migrated: boolean;
}

export function restoreProcessState(
	entries: readonly unknown[],
	defaultViewMode: TaskboardViewMode = "compact",
): RestoreResult {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TASKBOARD_ENTRY_TYPE) continue;
		if (!isPersistedTaskboardState(entry.data)) {
			return { state: createTombstone("compact"), corrupted: true, migrated: false };
		}
		const migrated = Boolean(entry.data.snapshot?.steps.some((step) => !step.id)
			|| entry.data.telemetry?.steps.some((step) => !step.id));
		return {
			state: entry.data.snapshot
				? createPersistedState(entry.data.snapshot, entry.data.viewMode, entry.data.telemetry)
				: { ...entry.data },
			corrupted: false,
			migrated,
		};
	}
	return { state: createPersistedState(undefined, defaultViewMode), corrupted: false, migrated: false };
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
