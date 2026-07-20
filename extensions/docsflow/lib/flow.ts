import { randomUUID } from "node:crypto";
import path from "node:path";

import { parseContractFromText, parentSummary, type ArtifactContract } from "./contract.ts";
import { buildDocsDelegationRequest, delegateDocsAgent, type DelegationEventBus } from "./delegate.ts";
import { loadDocsAgentProfiles, type DocsAgentProfile } from "./profiles.ts";
import {
	type DocsflowState,
	type DocsStage,
	emptyState,
	loadState,
	saveState,
	stateDir,
} from "./state.ts";
import {
	defaultProjectSlug,
	describeOutputMode,
	loadDocsflowConfig,
	resolveDocsflowOutputRoot,
	type DocsflowConfig,
	type DocsflowStageOverride,
} from "./vault.ts";
import { materializeArtifacts } from "./write-artifacts.ts";

export const STAGE_AGENT: Record<DocsStage, string> = {
	research: "research-analyst",
	product: "product-architect",
	interface: "interface-designer",
	delivery: "delivery-reviewer",
};

export const STAGE_STATUS = {
	research: "running_research",
	product: "running_product",
	interface: "running_interface",
	delivery: "running_delivery",
} as const;

export const STAGE_ORDER: DocsStage[] = ["research", "product", "interface", "delivery"];

export interface FlowRunResult {
	state: DocsflowState;
	contract?: ArtifactContract;
	summary: string;
	written: string[];
}

export function profilesByName(profiles = loadDocsAgentProfiles()): Map<string, DocsAgentProfile> {
	return new Map(profiles.map((profile) => [profile.name, profile]));
}

export function resolveStageRunConfig(
	profile: DocsAgentProfile,
	stage: DocsStage,
	overrides: Partial<Record<DocsStage, DocsflowStageOverride>>,
): { model?: string; timeoutMs: number } {
	const override = overrides[stage];
	const baseModel = override?.model ?? profile.model;
	const thinking = override?.thinking ?? profile.thinking;
	const model = baseModel && thinking ? `${baseModel}:${thinking}` : baseModel;
	return {
		...(model ? { model } : {}),
		timeoutMs: override?.timeoutMs ?? (profile.timeoutSeconds ? profile.timeoutSeconds * 1000 : 900_000),
	};
}

export function applyContractOutcome(
	state: DocsflowState,
	stage: DocsStage,
	status: ArtifactContract["status"],
	summary: string,
): void {
	state.activeAgent = null;
	if (status === "completed") {
		if (!state.completedStages.includes(stage)) state.completedStages = [...state.completedStages, stage];
		state.currentStage = null;
		state.lastError = undefined;
		state.status = stage === "delivery" ? "ready" : "idle";
		return;
	}

	state.currentStage = stage;
	state.status = status === "failed" ? "failed" : "blocked";
	state.lastError = summary;
}

/** Linear pipeline. External review (Hermes etc.) is optional and never blocks. */
export function nextAction(state: DocsflowState): { kind: "run" | "ready"; stage?: DocsStage } {
	const done = new Set(state.completedStages);
	for (const stage of STAGE_ORDER) {
		if (!done.has(stage)) return { kind: "run", stage };
	}
	return { kind: "ready" };
}

function taskFor(stage: DocsStage, requirement: string, outputRootLabel: string): string {
	const base = [
		"Follow the project-docs skill and return ONE JSON object matching the Artifact Contract.",
		"Use read-only tools only. Put full markdown documents in artifacts[].content.",
		"Artifact paths are relative to the project's docsflow folder (e.g. 00_Research.md), not absolute paths.",
		`Do not claim files were written; parent docsflow writes into Obsidian at: ${outputRootLabel}`,
		`Requirement:\n${requirement}`,
	];
	switch (stage) {
		case "research":
			return [...base, "Produce 00_Research.md only. External review packages are optional extras."].join("\n\n");
		case "product":
			return [...base, "Use research notes and repo evidence. Produce 01_Product_Spec.md."].join("\n\n");
		case "interface":
			return [...base, "Use product spec and repo evidence. Produce 02_Interface_Spec.md."].join("\n\n");
		case "delivery":
			return [...base, "Review upstream docsflow notes. Produce 03_Engineering_Handoff.md."].join("\n\n");
	}
}

export async function runStage(options: {
	projectRoot: string;
	stage: DocsStage;
	events: DelegationEventBus;
	agentDir?: string;
	signal?: AbortSignal;
	onUpdate?: (value: unknown) => void;
	profiles?: Map<string, DocsAgentProfile>;
}): Promise<FlowRunResult> {
	const profiles = options.profiles ?? profilesByName();
	const agentName = STAGE_AGENT[options.stage];
	const profile = profiles.get(agentName);
	if (!profile) throw new Error(`Missing profile: ${agentName}`);
	const run = resolveStageRunConfig(profile, options.stage, loadDocsflowConfig(options.agentDir).stageOverrides);
	if (run.model?.startsWith("blocked/")) {
		throw new Error(`Profile ${agentName} model is blocked (${run.model}). Update MODEL_RESOLUTION and agent frontmatter.`);
	}

	const state = loadState(options.projectRoot);
	if (!state.outputRoot) throw new Error("docsflow outputRoot missing; run /docsflow start first");

	state.status = STAGE_STATUS[options.stage];
	state.currentStage = options.stage;
	state.activeAgent = agentName;
	state.lastError = undefined;
	if (run.model) state.modelResolution[agentName] = run.model;
	saveState(options.projectRoot, state);

	const response = await delegateDocsAgent({
		events: options.events,
		request: buildDocsDelegationRequest({
			requestId: randomUUID(),
			agent: agentName,
			cwd: options.projectRoot,
			task: taskFor(options.stage, state.requirement || "(no requirement text)", state.outputRoot),
			model: run.model,
			timeoutMs: run.timeoutMs,
			skill: profile.skills.includes("project-docs") ? "project-docs" : false,
		}),
		signal: options.signal,
		onUpdate: options.onUpdate,
	});

	if (response.status !== "completed") {
		const failed = loadState(options.projectRoot);
		failed.status = "failed";
		failed.activeAgent = null;
		failed.currentStage = options.stage;
		failed.lastError = response.error || `Delegation status: ${response.status}`;
		saveState(options.projectRoot, failed);
		return { state: failed, summary: failed.lastError, written: [] };
	}

	const contract = parseContractFromText(response.output ?? "");
	const write = materializeArtifacts({
		outputRoot: state.outputRoot,
		allowlist: profile.artifactAllowlist,
		artifacts: contract.artifacts,
	});

	const next = loadState(options.projectRoot);
	next.generatedArtifacts = unique([...next.generatedArtifacts, ...write.formal]);
	next.draftArtifacts = unique([...next.draftArtifacts, ...write.drafts]);
	applyContractOutcome(next, options.stage, contract.status, contract.summary);

	saveState(options.projectRoot, next);
	return {
		state: next,
		contract,
		summary: parentSummary(contract, write.written.map((rel) => path.join(next.outputRoot, rel))),
		written: write.written,
	};
}

export function bindOutputRoots(options: {
	projectRoot: string;
	requirement: string;
	projectSlug?: string;
	agentDir?: string;
}): { state: DocsflowState; config: DocsflowConfig } {
	const config = loadDocsflowConfig(options.agentDir);
	const projectSlug = defaultProjectSlug(options.projectRoot, options.projectSlug);
	const outputRoot = resolveDocsflowOutputRoot({
		config,
		projectRoot: options.projectRoot,
		projectSlug,
	});
	const state = emptyState({
		requirement: options.requirement.trim(),
		projectSlug,
		vaultRoot: config.vaultEnabled ? config.vaultRoot : options.projectRoot,
		outputRoot,
		status: "idle",
	});
	if (!state.requirement) throw new Error("Requirement text is required");
	saveState(options.projectRoot, state);
	return { state, config };
}

export async function startFlow(options: {
	projectRoot: string;
	requirement: string;
	projectSlug?: string;
	agentDir?: string;
	events: DelegationEventBus;
	signal?: AbortSignal;
	onUpdate?: (value: unknown) => void;
}): Promise<FlowRunResult> {
	bindOutputRoots({
		projectRoot: options.projectRoot,
		requirement: options.requirement,
		projectSlug: options.projectSlug,
		agentDir: options.agentDir,
	});
	return runStage({
		projectRoot: options.projectRoot,
		stage: "research",
		events: options.events,
		agentDir: options.agentDir,
		signal: options.signal,
		onUpdate: options.onUpdate,
	});
}

export async function resumeFlow(options: {
	projectRoot: string;
	events: DelegationEventBus;
	agentDir?: string;
	signal?: AbortSignal;
	onUpdate?: (value: unknown) => void;
}): Promise<FlowRunResult> {
	const state = loadState(options.projectRoot);
	if (!state.requirement || !state.outputRoot) {
		throw new Error("No docsflow state. Run /docsflow start <requirement> first.");
	}
	const action = nextAction(state);
	if (action.kind === "ready") {
		const ready = loadState(options.projectRoot);
		ready.status = "ready";
		ready.lastError = undefined;
		saveState(options.projectRoot, ready);
		return { state: ready, summary: `ready · docs at ${ready.outputRoot}`, written: [] };
	}
	return runStage({
		projectRoot: options.projectRoot,
		stage: action.stage!,
		events: options.events,
		agentDir: options.agentDir,
		signal: options.signal,
		onUpdate: options.onUpdate,
	});
}

export function describeLocation(state: DocsflowState, config?: DocsflowConfig, projectRoot?: string): string {
	if (!state.outputRoot) return "(no output root)";
	if (!config) return state.outputRoot;
	return describeOutputMode(config, state.outputRoot, projectRoot);
}

export function backupRootFor(projectRoot: string): string {
	return path.join(stateDir(projectRoot), "backups");
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}
