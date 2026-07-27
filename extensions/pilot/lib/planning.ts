import path from "node:path";

import {
	markPilotBundleReady,
	updatePilotBundle,
	writePilotBundleArtifact,
	type PilotBundle,
} from "./bundle.ts";

export interface PilotPlanningResult {
	goal: string;
	scope: string[];
	nonGoals: string[];
	acceptance: string[];
	writeRoots: string[];
	verificationCommands: string[];
	risks: string[];
	needsDecision?: string;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pilot planner result must be an object.");
	return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Pilot planner ${field} must be a non-empty string.`);
	return value.trim();
}

function stringList(value: unknown, field: string, required: boolean): string[] {
	if (!Array.isArray(value) || (required && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`Pilot planner ${field} must be ${required ? "a non-empty" : "an"} string array.`);
	}
	return [...new Set(value.map((item) => (item as string).trim()))];
}

function normalizeWriteRoot(value: string): string {
	const normalized = value.replaceAll("\\", "/").trim();
	if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
		throw new Error("Pilot planner writeRoots must be relative directories.");
	}
	const resolved = path.posix.normalize(normalized);
	if (resolved === ".." || resolved.startsWith("../") || resolved.includes("/../")) {
		throw new Error("Pilot planner writeRoots must not escape the project.");
	}
	return resolved === "./" ? "." : resolved;
}

export function validateVerificationCommand(command: string): string {
	const normalized = command.trim().replace(/\s+/g, " ");
	if (!/^(?:npm|pnpm|yarn|bun) (?:test|run [A-Za-z0-9:_-]+)$/.test(normalized)) {
		throw new Error("Pilot planner verificationCommands only support package-manager test or run commands.");
	}
	return normalized;
}

export function extractPlanningJson(output: string): unknown {
	const trimmed = output.trim();
	if (!trimmed) throw new Error("Pilot planner returned no output.");
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const candidate = fenced ?? trimmed;
	try {
		return JSON.parse(candidate);
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start < 0 || end <= start) throw new Error("Pilot planner did not return a JSON object.");
		try {
			return JSON.parse(candidate.slice(start, end + 1));
		} catch (error) {
			throw new Error(`Pilot planner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export function parsePilotPlanningResult(output: string): PilotPlanningResult {
	const value = record(extractPlanningJson(output));
	const supported = new Set(["goal", "scope", "nonGoals", "acceptance", "writeRoots", "verificationCommands", "risks", "needsDecision"]);
	const unsupported = Object.keys(value).find((key) => !supported.has(key));
	if (unsupported) throw new Error(`Pilot planner returned unsupported field: ${unsupported}.`);
	const writeRoots = stringList(value.writeRoots, "writeRoots", true).map(normalizeWriteRoot).sort();
	if (new Set(writeRoots).size !== writeRoots.length) throw new Error("Pilot planner writeRoots must not contain duplicates.");
	const needsDecision = value.needsDecision === undefined ? undefined : requiredText(value.needsDecision, "needsDecision");
	return {
		goal: requiredText(value.goal, "goal"),
		scope: stringList(value.scope, "scope", true),
		nonGoals: stringList(value.nonGoals, "nonGoals", false),
		acceptance: stringList(value.acceptance, "acceptance", true),
		writeRoots,
		verificationCommands: stringList(value.verificationCommands, "verificationCommands", true).map(validateVerificationCommand),
		risks: stringList(value.risks, "risks", false),
		...(needsDecision ? { needsDecision } : {}),
	};
}

function markdownList(values: readonly string[]): string {
	return values.length ? values.map((value) => `- ${value}`).join("\n") : "- None";
}

export function renderRequirements(result: PilotPlanningResult): string {
	return [
		"# Requirements",
		"",
		"## Goal",
		result.goal,
		"",
		"## Approved Scope",
		markdownList(result.scope),
		"",
		"## Non-goals",
		markdownList(result.nonGoals),
		"",
		"## Acceptance",
		markdownList(result.acceptance),
		"",
		"## Risks",
		markdownList(result.risks),
	].join("\n");
}

export function renderHandoff(result: PilotPlanningResult): string {
	return [
		"# Engineering Handoff",
		"",
		"## Goal",
		result.goal,
		"",
		"## Write Roots",
		markdownList(result.writeRoots),
		"",
		"## Validation Commands",
		markdownList(result.verificationCommands),
		"",
		"## Acceptance",
		markdownList(result.acceptance),
		"",
		"## Scope",
		markdownList(result.scope),
	].join("\n");
}

export function materializePilotPlan(bundle: PilotBundle, result: PilotPlanningResult): PilotBundle {
	let next = writePilotBundleArtifact(bundle, "requirements", renderRequirements(result));
	next = writePilotBundleArtifact(next, "handoff", renderHandoff(result));
	next = updatePilotBundle(next, (current) => ({
		...current,
		workPlan: {
			writeRoots: result.writeRoots,
			verificationCommands: result.verificationCommands,
			acceptance: result.acceptance,
		},
	}));
	if (result.needsDecision) {
		return updatePilotBundle(next, (current) => ({
			...current,
			status: "blocked",
			phase: "planning",
			needsDecision: result.needsDecision,
			activeRequest: undefined,
		}));
	}
	return markPilotBundleReady(next);
}
