import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { isProcessSnapshot, isProcessTelemetry, sanitizeProcessText, stepElapsedMs } from "./state.ts";
import type {
	ActivitySnapshot,
	ProcessRenderState,
	ProcessSnapshot,
	ProcessStatus,
	ProcessStep,
	ProcessStepTelemetry,
	ProcessTelemetry,
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

function stepSymbol(step: ProcessStep): string {
	if (step.status === "done") return "✓";
	if (step.status === "active") return "●";
	if (step.status === "failed") return "!";
	return "○";
}

function formatTool(tool: Pick<ToolActivity, "toolName" | "label">): string {
	if (!tool.label || tool.label === tool.toolName) return tool.toolName;
	// Aux updates already include the tool name ("web_research · model").
	if (tool.label.startsWith(`${tool.toolName} `) || tool.label.startsWith(`${tool.toolName} ·`)) return tool.label;
	return `${tool.toolName} ${tool.label}`;
}

function formatOutcome(outcome: RecentToolOutcome): string {
	return `${outcome.isError ? "!" : "✓"} ${formatTool(outcome)}`;
}

function formatActivity(activity: ActivitySnapshot): { text?: string; active: boolean } {
	if (activity.activeTools.length > 0) {
		const count = activity.activeTools.length;
		return { text: `Running ${count} tool${count === 1 ? "" : "s"}`, active: true };
	}
	return {
		...(activity.recentOutcome ? { text: activity.recentOutcome.isError ? "Latest tool failed" : "Latest tool finished" } : {}),
		active: false,
	};
}

function fit(lines: string[], width: number): string[] {
	if (width < 1) return [];
	return lines.map((line) => truncateToWidth(line, width));
}

function formatElapsed(ms: number | undefined): string {
	if (ms === undefined) return "—";
	const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const suffix = `${String(minutes).padStart(hours > 0 ? 2 : 1, "0")}m${String(seconds).padStart(2, "0")}s`;
	return hours > 0 ? `${hours}h${suffix}` : suffix;
}

function formatTokens(count: number): string {
	if (count < 1_000) return Math.round(count).toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
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

function telemetryForStep(
	snapshot: ProcessSnapshot,
	telemetry: ProcessTelemetry | undefined,
	step: ProcessStep | undefined,
): ProcessStepTelemetry | undefined {
	if (!step || !telemetry) return undefined;
	const index = snapshot.steps.indexOf(step);
	return telemetry.steps[index]?.text === step.text ? telemetry.steps[index] : undefined;
}

function totalElapsedMs(telemetry: ProcessTelemetry | undefined, now: number): number | undefined {
	if (!telemetry || telemetry.steps.length === 0) return undefined;
	let total = 0;
	let observed = false;
	for (const step of telemetry.steps) {
		const elapsed = stepElapsedMs(step, now);
		if (elapsed === undefined) continue;
		observed = true;
		total += elapsed;
	}
	return observed ? total : undefined;
}

function formatTokenPair(usage: { input: number; output: number }): string {
	return `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`;
}

function compactSummary(state: ProcessRenderState, width: number, theme: ProcessTheme): string {
	const snapshot = state.snapshot!;
	const meta = STATUS_META[snapshot.status];
	const current = currentStep(snapshot);
	const elapsed = formatElapsed(stepElapsedMs(telemetryForStep(snapshot, state.telemetry, current), state.now));
	const symbol = theme.fg(meta.tone, snapshot.status === "running" ? meta.symbol : `${meta.symbol} ${meta.label}`);
	const progress = `${doneCount(snapshot)}/${snapshot.steps.length}`;
	const currentLabel = width >= 90 ? "Now: " : "";
	const fixed = `${symbol}  · ${progress} · ${currentLabel} · ${elapsed}`;
	const available = width - visibleWidth(fixed);
	if (available < 8) return truncateToWidth(`${symbol} ${progress} · ${elapsed}`, width);
	const goalWidth = Math.max(4, Math.floor(available * 0.52));
	const currentWidth = Math.max(4, available - goalWidth);
	const goal = truncateToWidth(snapshot.title, goalWidth, "…");
	const focus = truncateToWidth(current?.text ?? snapshot.title, currentWidth, "…");
	return `${symbol} ${goal} · ${progress} · ${currentLabel}${focus} · ${elapsed}`;
}

function compactLines(state: ProcessRenderState, width: number, theme: ProcessTheme): string[] {
	const snapshot = state.snapshot!;
	const lines = [compactSummary(state, width, theme)];
	if (state.activityMode === "full") {
		const activity = formatActivity(state.activity);
		if (activity.text) lines.push(`  ${activity.active ? "↳ " : ""}${activity.text}`);
		else {
			const stage = STAGE_LABELS[state.activity.stage];
			if (stage) lines.push(`  ${stage}`);
		}
	}
	const detail = detailLine(snapshot);
	if (detail) lines.push(`  ${detail}`);
	return lines.slice(0, width < 72 ? 2 : 3);
}

function modelSummary(models: readonly string[]): string {
	if (models.length === 0) return "—";
	return models.length === 1 ? truncateToWidth(models[0]!, 32, "…") : `${models.length} models`;
}

function alignColumns(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width);
	const rightWidth = visibleWidth(right);
	if (rightWidth + 5 >= width) return truncateToWidth(`${left} · ${right}`, width);
	const boundedLeft = truncateToWidth(left, width - rightWidth - 1, "…");
	return `${boundedLeft}${" ".repeat(Math.max(1, width - visibleWidth(boundedLeft) - rightWidth))}${right}`;
}

function boxRow(content: string, width: number, theme: ProcessTheme): string {
	if (width < 3) return truncateToWidth(content, width);
	const innerWidth = width - 2;
	const body = truncateToWidth(content, innerWidth);
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(body)));
	return `${theme.fg("dim", "│")}${body}${padding}${theme.fg("dim", "│")}`;
}

function boxBorder(kind: "top" | "section" | "bottom", width: number, theme: ProcessTheme, label = ""): string {
	if (width < 2) return truncateToWidth(label, width);
	const [left, right] = kind === "top" ? ["╭", "╮"] : kind === "bottom" ? ["╰", "╯"] : ["├", "┤"];
	const innerWidth = width - 2;
	const labelContent = kind === "section" && label ? `─ ${label} ` : "";
	const content = truncateToWidth(labelContent, innerWidth);
	const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(content)));
	return theme.fg("dim", `${left}${content}${fill}${right}`);
}

function hasObservedTelemetry(metric: ProcessStepTelemetry | undefined): metric is ProcessStepTelemetry {
	return Boolean(metric && (
		metric.activeSince !== undefined
		|| metric.activeMs > 0
		|| metric.turns > 0
		|| metric.models.length > 0
		|| Object.values(metric.usage).some((value) => value > 0)
	));
}

function taskMetrics(metric: ProcessStepTelemetry | undefined, now: number, width: number): string {
	if (!hasObservedTelemetry(metric)) return "—";
	const elapsed = formatElapsed(stepElapsedMs(metric, now));
	const tokens = formatTokenPair(metric.usage);
	if (width < 62) return elapsed;
	if (width < 88) return `${metric.turns} turns · ${tokens} · ${elapsed}`;
	return `${modelSummary(metric.models)} · ${metric.turns} turns · ${tokens} · ${elapsed}`;
}

function runtimeLine(telemetry: ProcessTelemetry | undefined): string {
	if (!telemetry) return "Runtime: telemetry unavailable";
	const turns = `${telemetry.turns} turn${telemetry.turns === 1 ? "" : "s"}`;
	const usage = telemetry.usage;
	const cost = usage.cost > 0 ? ` · $${usage.cost.toFixed(3)}` : "";
	return `Runtime: ${modelSummary(telemetry.models)} · ${turns} · ${formatTokenPair(usage)} · R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)}${cost}`;
}

function detailedActivity(state: ProcessRenderState): string | undefined {
	if (state.activity.activeTools.length > 0) {
		const shown = state.activity.activeTools.slice(0, 2).map((tool) =>
			`${formatTool(tool)} ${formatElapsed(Math.max(0, state.now - tool.startedAt))}`);
		const remaining = state.activity.activeTools.length - shown.length;
		if (remaining > 0) shown.push(`+${remaining} tool${remaining === 1 ? "" : "s"}`);
		return `Active: ${shown.join(" · ")}`;
	}
	if (state.activity.recentOutcome) return `Recent: ${formatOutcome(state.activity.recentOutcome)}`;
	const stage = STAGE_LABELS[state.activity.stage];
	return stage ? `Stage: ${stage}` : undefined;
}

function detailPanelLines(state: ProcessRenderState, width: number, theme: ProcessTheme): string[] {
	if (width < 1) return [];
	const snapshot = state.snapshot!;
	const meta = STATUS_META[snapshot.status];
	const progress = `${doneCount(snapshot)}/${snapshot.steps.length}`;
	const current = currentStep(snapshot);
	const currentMetric = telemetryForStep(snapshot, state.telemetry, current);
	const totalElapsed = formatElapsed(totalElapsedMs(state.telemetry, state.now));
	const currentElapsed = formatElapsed(stepElapsedMs(currentMetric, state.now));
	const lines = [boxBorder("top", width, theme)];
	lines.push(boxRow(` ${theme.bold("Process View")} · ${meta.label} · ${progress} · ${snapshot.title}`, width, theme));
	lines.push(boxRow(` Time: total ${totalElapsed} · current ${currentElapsed}`, width, theme));
	if (current) {
		lines.push(boxRow(` Current: ${current.text}`, width, theme));
	}
	lines.push(boxBorder("section", width, theme, "Tasks"));
	for (let index = 0; index < snapshot.steps.length; index += 1) {
		const step = snapshot.steps[index]!;
		const left = ` ${stepSymbol(step)} ${step.text}`;
		const right = taskMetrics(state.telemetry?.steps[index], state.now, width);
		lines.push(boxRow(alignColumns(left, right, Math.max(0, width - 2)), width, theme));
	}
	lines.push(boxBorder("section", width, theme, "Runtime"));
	lines.push(boxRow(` ${runtimeLine(state.telemetry)}`, width, theme));
	const activity = state.activityMode === "off" ? undefined : detailedActivity(state);
	if (activity) lines.push(boxRow(` ${activity}`, width, theme));
	const latest = detailLine(snapshot);
	if (latest) lines.push(boxRow(` ${latest}`, width, theme));
	lines.push(boxBorder("bottom", width, theme));
	return lines.slice(0, 15);
}

export function formatProcessLines(
	state: ProcessRenderState,
	width: number,
	theme: ProcessTheme,
): string[] {
	if (state.viewMode === "off") return [];
	if (!state.snapshot) return state.activityMode === "full" ? fit(passiveLines(state, theme), width) : [];
	return state.viewMode === "full" || state.expanded
		? detailPanelLines(state, width, theme)
		: fit(compactLines(state, width, theme), width);
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
	const rawTelemetry = (result.details as { telemetry?: unknown }).telemetry;
	const telemetry = isProcessTelemetry(rawTelemetry, snapshot) ? rawTelemetry : undefined;
	const lines = [`${meta.symbol} ${meta.label} · ${done}/${snapshot.steps.length} ${snapshot.title}`];
	for (let index = 0; index < snapshot.steps.length; index += 1) {
		const step = snapshot.steps[index]!;
		const metric = telemetry?.steps[index];
		const elapsed = hasObservedTelemetry(metric)
			? ` · ${formatElapsed(stepElapsedMs(metric, snapshot.updatedAt))}`
			: "";
		lines.push(`${stepSymbol(step)} ${step.text}${elapsed}`);
	}
	if (snapshot.update) lines.push(`Update: ${snapshot.update}`);
	if (snapshot.blocker) lines.push(`Need: ${snapshot.blocker}`);
	if (snapshot.verification) lines.push(`Verification: ${snapshot.verification}`);
	if (telemetry) lines.push(runtimeLine(telemetry));
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
