import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { isProcessSnapshot, sanitizeProcessText } from "./state.ts";
import type {
	ActivitySnapshot,
	ProcessRenderState,
	ProcessSnapshot,
	ProcessStatus,
	ProcessStep,
	RecentToolOutcome,
	RuntimeStage,
	ToolActivity,
} from "./types.ts";

export type ProcessTone = "accent" | "success" | "dim" | "muted" | "error" | "warning";

export interface ProcessTheme {
	fg(color: ProcessTone, text: string): string;
	bold(text: string): string;
}

interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

const STATUS_META: Record<ProcessStatus, { symbol: string; label: string; tone: ProcessTone }> = {
	running: { symbol: "●", label: "Running", tone: "accent" },
	waiting: { symbol: "·", label: "Waiting", tone: "muted" },
	blocked: { symbol: "!", label: "Blocked", tone: "error" },
	completed: { symbol: "✓", label: "Done", tone: "success" },
	interrupted: { symbol: "!", label: "Interrupted", tone: "warning" },
};

const STAGE_LABELS: Partial<Record<RuntimeStage, string>> = {
	starting: "Starting",
	analyzing: "Analyzing request",
	preparing_tools: "Preparing tools",
	running_tools: "Running tools",
	analyzing_results: "Analyzing results",
	drafting: "Drafting response",
};

function doneCount(snapshot: ProcessSnapshot): number {
	return snapshot.steps.filter((step) => step.status === "done").length;
}

function currentStep(snapshot: ProcessSnapshot): ProcessStep | undefined {
	return snapshot.steps.find((step) => step.status === "active")
		?? snapshot.steps.find((step) => step.status === "failed")
		?? snapshot.steps.find((step) => step.status === "pending")
		?? snapshot.steps.at(-1);
}

function nextStep(snapshot: ProcessSnapshot, current: ProcessStep | undefined): ProcessStep | undefined {
	const currentIndex = current ? snapshot.steps.indexOf(current) : -1;
	return snapshot.steps.find((step, index) => index > currentIndex && step.status === "pending");
}

function stepSymbol(step: ProcessStep): string {
	if (step.status === "done") return "✓";
	if (step.status === "active") return "●";
	if (step.status === "failed") return "!";
	return "○";
}

function formatTool(tool: Pick<ToolActivity, "toolName" | "label">): string {
	return tool.label && tool.label !== tool.toolName ? `${tool.toolName} ${tool.label}` : tool.toolName;
}

function formatOutcome(outcome: RecentToolOutcome): string {
	return `${outcome.isError ? "!" : "✓"} ${formatTool(outcome)}`;
}

function formatActivity(activity: ActivitySnapshot): { text?: string; active: boolean } {
	if (activity.activeTools.length > 0) {
		const shown = activity.activeTools.slice(0, 2).map(formatTool);
		const remaining = activity.activeTools.length - shown.length;
		if (remaining > 0) shown.push(`+${remaining} tool${remaining === 1 ? "" : "s"}`);
		return { text: shown.join(" · "), active: true };
	}
	return {
		...(activity.recentOutcome ? { text: formatOutcome(activity.recentOutcome) } : {}),
		active: false,
	};
}

function fit(lines: string[], width: number): string[] {
	if (width < 1) return [];
	return lines.map((line) => truncateToWidth(line, width));
}

function header(snapshot: ProcessSnapshot, theme: ProcessTheme): string {
	const meta = STATUS_META[snapshot.status];
	const status = theme.fg(meta.tone, `${meta.symbol} ${meta.label}`);
	return `${theme.bold(status)} · ${doneCount(snapshot)}/${snapshot.steps.length}  ${snapshot.title}`;
}

function detailLine(snapshot: ProcessSnapshot): string | undefined {
	if (snapshot.status === "blocked" && snapshot.blocker) return `Need: ${snapshot.blocker}`;
	if (snapshot.status === "interrupted" && snapshot.update) return `Update: ${snapshot.update}`;
	if (snapshot.status === "completed" && snapshot.verification) return `Verification: ${snapshot.verification}`;
	if (snapshot.update) return `Update: ${snapshot.update}`;
	if (snapshot.artifacts.length > 0) return `Artifacts: ${snapshot.artifacts.map((artifact) => artifact.label).join(" · ")}`;
	return undefined;
}

function passiveLines(state: ProcessRenderState, theme: ProcessTheme): string[] {
	const label = STAGE_LABELS[state.activity.stage];
	if (!label) return [];
	const activity = formatActivity(state.activity);
	const suffix = activity.text ? ` · ${activity.text}` : "";
	return [`${theme.fg("accent", "●")} ${label}${suffix}`];
}

function fullLines(state: ProcessRenderState, theme: ProcessTheme): string[] {
	const snapshot = state.snapshot!;
	const activity = formatActivity(state.activity);
	const lines = [header(snapshot, theme)];
	for (const step of snapshot.steps) lines.push(`  ${stepSymbol(step)} ${step.text}`);
	if (activity.text) lines.push(activity.active ? `  ↳ ${activity.text}` : `  ${activity.text}`);
	if (snapshot.status === "blocked" && snapshot.blocker) lines.push(`  Need: ${snapshot.blocker}`);
	else if (snapshot.update) lines.push(`  Update: ${snapshot.update}`);
	if (snapshot.verification) lines.push(`  Verification: ${snapshot.verification}`);
	if (snapshot.artifacts.length > 0) {
		lines.push(`  Artifacts: ${snapshot.artifacts.map((artifact) => artifact.label).join(" · ")}`);
	}
	return lines.slice(0, 9);
}

function wideLines(state: ProcessRenderState, theme: ProcessTheme): string[] {
	const snapshot = state.snapshot!;
	const activity = formatActivity(state.activity);
	const rail = snapshot.steps.map((step) => `${stepSymbol(step)} ${step.text}`).join("  ");
	const lines = [header(snapshot, theme), `  ${rail}`];
	if (activity.text) lines.push(activity.active ? `  ↳ ${activity.text}` : `  ${activity.text}`);
	const detail = detailLine(snapshot);
	if (detail) lines.push(`  ${detail}`);
	return lines.slice(0, 4);
}

function mediumLines(state: ProcessRenderState, theme: ProcessTheme): string[] {
	const snapshot = state.snapshot!;
	const current = currentStep(snapshot);
	const next = nextStep(snapshot, current);
	const activity = formatActivity(state.activity);
	const lines = [header(snapshot, theme)];
	if (current) lines.push(`  Current: ${current.text}${next ? ` · Next: ${next.text}` : ""}`);
	if (activity.text) lines.push(activity.active ? `  ↳ ${activity.text}` : `  ${activity.text}`);
	const detail = detailLine(snapshot);
	if (detail) lines.push(`  ${detail}`);
	return lines.slice(0, 4);
}

function narrowLines(state: ProcessRenderState, theme: ProcessTheme): string[] {
	const snapshot = state.snapshot!;
	const meta = STATUS_META[snapshot.status];
	const current = currentStep(snapshot);
	const activity = formatActivity(state.activity);
	const focus = snapshot.status === "blocked" && snapshot.blocker
		? `Need: ${snapshot.blocker}`
		: snapshot.status === "interrupted" && snapshot.update
			? snapshot.update
			: current?.text ?? snapshot.title;
	const base = `${theme.fg(meta.tone, meta.symbol)} ${doneCount(snapshot)}/${snapshot.steps.length} ${focus}`;
	return [`${base}${activity.text ? ` · ${activity.text}` : ""}`];
}

export function formatProcessLines(
	state: ProcessRenderState,
	width: number,
	theme: ProcessTheme,
): string[] {
	if (state.viewMode === "off") return [];
	if (!state.snapshot) return fit(passiveLines(state, theme), width);
	const lines = state.viewMode === "full"
		? fullLines(state, theme)
		: width >= 100
			? wideLines(state, theme)
			: width >= 72
				? mediumLines(state, theme)
				: narrowLines(state, theme);
	return fit(lines, width);
}

export class ProcessWidget implements Component {
	private readonly getState: () => ProcessRenderState;
	private readonly theme: ProcessTheme;

	constructor(getState: () => ProcessRenderState, theme: ProcessTheme) {
		this.getState = getState;
		this.theme = theme;
	}

	render(width: number): string[] {
		return formatProcessLines(this.getState(), width, this.theme);
	}

	invalidate(): void {}
}

export function formatToolResultLines(
	result: ToolResultLike,
	expanded: boolean,
	isError: boolean,
): string[] {
	if (isError) {
		const errorText = result.content.find((content) => content.type === "text")?.text;
		return [sanitizeProcessText(errorText ?? "") || "Process update failed"];
	}
	if (!isProcessSnapshot(result.details)) {
		const text = result.content.find((content) => content.type === "text")?.text;
		return [sanitizeProcessText(text ?? "") || "Process update finished"];
	}

	const snapshot = result.details;
	const done = doneCount(snapshot);
	if (!expanded) {
		if (snapshot.status === "completed") {
			const summary = snapshot.update ?? snapshot.verification ?? snapshot.title;
			const artifacts = snapshot.artifacts.length > 0
				? ` · ${snapshot.artifacts.length} artifact${snapshot.artifacts.length === 1 ? "" : "s"}`
				: "";
			return [`Process done ${done}/${snapshot.steps.length} · ${summary}${artifacts}`];
		}
		return [`Process ${done}/${snapshot.steps.length} · ${currentStep(snapshot)?.text ?? snapshot.title}`];
	}

	const meta = STATUS_META[snapshot.status];
	const lines = [`${meta.symbol} ${meta.label} · ${done}/${snapshot.steps.length} ${snapshot.title}`];
	for (const step of snapshot.steps) lines.push(`${stepSymbol(step)} ${step.text}`);
	if (snapshot.update) lines.push(`Update: ${snapshot.update}`);
	if (snapshot.blocker) lines.push(`Need: ${snapshot.blocker}`);
	if (snapshot.verification) lines.push(`Verification: ${snapshot.verification}`);
	if (snapshot.artifacts.length > 0) {
		lines.push(`Artifacts: ${snapshot.artifacts.map((artifact) => artifact.label).join(" · ")}`);
	}
	return lines;
}

export function renderToolResult(
	result: ToolResultLike,
	expanded: boolean,
	isError: boolean,
	theme: ProcessTheme,
): Component {
	const lines = formatToolResultLines(result, expanded, isError);
	return new Text(theme.fg(isError ? "error" : "muted", lines.join("\n")), 0, 0);
}
