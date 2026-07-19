import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export const DOCSFLOW_STATUS_KEY = "docsflow";
export const STATE_VERSION = 2 as const;

export type DocsflowStatus =
	| "idle"
	| "running_research"
	| "running_product"
	| "running_interface"
	| "running_delivery"
	| "ready"
	| "blocked"
	| "failed";

export type DocsStage = "research" | "product" | "interface" | "delivery";

export interface DocsflowState {
	version: typeof STATE_VERSION;
	requirement: string;
	projectSlug: string;
	vaultRoot: string;
	outputRoot: string;
	status: DocsflowStatus;
	currentStage: DocsStage | null;
	completedStages: DocsStage[];
	activeAgent: string | null;
	generatedArtifacts: string[];
	draftArtifacts: string[];
	modelResolution: Record<string, string>;
	lastError?: string;
	startedAt: string;
	updatedAt: string;
}

export function stateDir(projectRoot: string): string {
	return path.join(projectRoot, ".pi", "docsflow");
}

export function statePath(projectRoot: string): string {
	return path.join(stateDir(projectRoot), "state.json");
}

export function emptyState(partial?: Partial<DocsflowState>): DocsflowState {
	const now = new Date().toISOString();
	return {
		version: STATE_VERSION,
		requirement: "",
		projectSlug: "",
		vaultRoot: "",
		outputRoot: "",
		status: "idle",
		currentStage: null,
		completedStages: [],
		activeAgent: null,
		generatedArtifacts: [],
		draftArtifacts: [],
		modelResolution: {},
		startedAt: now,
		updatedAt: now,
		...partial,
		version: STATE_VERSION,
	};
}

export function loadState(projectRoot: string): DocsflowState {
	const file = statePath(projectRoot);
	if (!existsSync(file)) return emptyState();
	const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DocsflowState>;
	return emptyState({
		...raw,
		completedStages: Array.isArray(raw.completedStages) ? (raw.completedStages as DocsStage[]) : [],
		generatedArtifacts: Array.isArray(raw.generatedArtifacts) ? raw.generatedArtifacts.map(String) : [],
		draftArtifacts: Array.isArray(raw.draftArtifacts) ? raw.draftArtifacts.map(String) : [],
		modelResolution:
			raw.modelResolution && typeof raw.modelResolution === "object"
				? (raw.modelResolution as Record<string, string>)
				: {},
	});
}

export function saveState(projectRoot: string, state: DocsflowState): void {
	mkdirSync(stateDir(projectRoot), { recursive: true });
	const next = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
	const file = statePath(projectRoot);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

export function resetState(projectRoot: string): DocsflowState {
	const prev = loadState(projectRoot);
	const next = emptyState({
		requirement: prev.requirement,
		projectSlug: prev.projectSlug,
		vaultRoot: prev.vaultRoot,
		outputRoot: prev.outputRoot,
	});
	saveState(projectRoot, next);
	return next;
}

export function statusLabel(state: DocsflowState): string | undefined {
	switch (state.status) {
		case "idle":
			return undefined;
		case "running_research":
			return "docsflow research";
		case "running_product":
			return "docsflow product";
		case "running_interface":
			return "docsflow interface";
		case "running_delivery":
			return "docsflow delivery";
		case "ready":
			return "docsflow ready";
		case "blocked":
			return "docsflow blocked";
		case "failed":
			return "docsflow failed";
		default:
			return "docsflow";
	}
}
