import {
	DEFAULT_CONFIG,
	enabledWidgets,
	MAX_CONTEXT_BAR_WIDTH,
	MIN_CONTEXT_BAR_WIDTH,
} from "./config.ts";
import { formatDurationPair } from "./duration.ts";
import {
	formatBranch,
	formatBranchDiff,
	formatCache,
	formatContextBar,
	formatContextText,
	formatContextUnavailable,
	formatCost,
	formatDurationContent,
	formatPathContent,
	formatSessionName,
	formatEnvironment,
	formatFastBadge,
	formatModeContent,
	formatModelContent,
	formatQuota,
	formatTokenDirection,
	formatTokenPairMinimal,
	formatToolActivity,
	formatWorktree,
	formatRuntime,
	formatRunMetric,
	thinkingLevelTone,
	type SegmentContent,
} from "./format.ts";
import { formatWidgetSeparator, groupSegmentsByLines, stripTerminalControls } from "./render.ts";
import type {
	RunState,
	StatusSnapshot,
	StatuslineConfig,
	WidgetId,
	WidgetLines,
	WidgetSegment,
} from "./types.ts";
import { WIDGET_PRIORITY } from "./types.ts";

/** Extension status keys that have dedicated widgets or live in Taskboard. */
export const EXCLUDED_PROGRESS_KEYS = new Set(["ponytail", "mode", "fast", "taskboard", "process", "auxiliary"]);

/** Metadata-only tools that should not appear in footer activity. */
export const EXCLUDED_TOOL_ACTIVITY_NAMES = new Set(["process_update"]);

export function shouldTrackToolActivity(toolName: string): boolean {
	return !EXCLUDED_TOOL_ACTIVITY_NAMES.has(toolName);
}

/** Status key written by /mode. */
export const MODE_STATUS_KEY = "mode";

/** Status key written by /fast. */
export const FAST_STATUS_KEY = "fast";

/** Status key written by Taskboard while waiting/blocked. */
export const TASKBOARD_STATUS_KEY = "taskboard";

/** Legacy status key accepted through Taskboard 0.1.x; remove when 0.2.0 is the baseline. */
export const PROCESS_STATUS_KEY = "process";

export function runStateForAssistantEvent(type: string): RunState | undefined {
	if (type.startsWith("thinking_")) return "Thinking";
	if (type.startsWith("text_") || type.startsWith("toolcall_")) return "Working";
	return undefined;
}

/** Promote Ready → Waiting when Taskboard is paused on subagent/external work. */
export function resolveRunState(
	runState: RunState,
	extensionStatuses?: ReadonlyMap<string, string> | Iterable<readonly [string, string]>,
): RunState {
	if (runState !== "Ready" || !extensionStatuses) return runState;
	const statuses = extensionStatuses instanceof Map ? extensionStatuses : new Map(extensionStatuses);
	const taskboardStatus = statuses.get(TASKBOARD_STATUS_KEY);
	const legacyProcessStatus = statuses.get(PROCESS_STATUS_KEY);
	const status = taskboardStatus ?? legacyProcessStatus;
	const normalized = status ? sanitizeStatus(status).toLowerCase() : "";
	return normalized === "waiting" || normalized === "blocked" ? "Waiting" : runState;
}

export function sanitizeStatus(text: string): string {
	return stripTerminalControls(text).replace(/ +/g, " ").trim();
}

/** Join extension statuses for the progress widget, skipping excluded keys. */
export function joinExtensionProgress(
	statuses: Iterable<readonly [string, string]>,
	excluded: ReadonlySet<string> = EXCLUDED_PROGRESS_KEYS,
): string | undefined {
	const parts: string[] = [];
	for (const [key, text] of statuses) {
		if (excluded.has(key)) continue;
		const clean = sanitizeStatus(text);
		if (clean) parts.push(clean);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Sample data for the widgets editor preview line. */
export const PREVIEW_SNAPSHOT: StatusSnapshot = {
	cwd: "/home/user/proj",
	sessionName: "session",
	modelId: "model",
	thinkingLevel: "high",
	hasReasoning: true,
	mode: "EDIT",
	fast: "",
	tokens: { input: 1500, output: 800, cacheRead: 4000, cacheWrite: 500 },
	cost: 0.42,
	context: { tokens: 40_000, contextWindow: 100_000, percent: 40 },
	branch: "main",
	branchDiff: { additions: 12, deletions: 3 },
	progress: "task 1/2",
	duration: { roundMs: 12_300, sessionMs: 105_000 },
	runState: "Ready",
	quota: {
		provider: "codex",
		windows: [
			{ id: "primary", label: "5h", usedPercent: 7, windowSeconds: 18_000 },
			{ id: "secondary", label: "7d", usedPercent: 33, windowSeconds: 604_800 },
		],
		capturedAt: Date.now(),
		stale: false,
	},
	environment: { contextFiles: 2, skills: 67, tools: 7 },
	toolActivity: {
		Read: { active: 0, success: 6, error: 0 },
		Bash: { active: 0, success: 3, error: 0 },
	},
	worktree: {
		branch: "main", oid: "abcdef123456", detached: false, ahead: 1, behind: 0, stash: 1,
		conflicted: 0, renamed: 1, deleted: 0, staged: 2, modified: 3, untracked: 1,
	},
	runtime: { name: "nodejs", version: "22.10.0" },
	performance: {
		tps: 42.5, ttftMs: 1_200, totalMs: 5_000, inputTokens: 50, outputTokens: 20,
		stallMs: 4_300, stallCount: 1, rateUsdPerMTokens: 4, generationMs: 470,
		totalTokens: 70, costUsd: 0.00028, measurementMs: 470, usageAvailable: true,
	},
};

function pushContent(
	segments: WidgetSegment[],
	id: WidgetId,
	accent: WidgetSegment["accent"],
	body: SegmentContent,
	priority: number,
	extra?: Partial<WidgetSegment>,
): void {
	segments.push({
		id,
		accent,
		text: body.text,
		parts: body.parts,
		priority,
		...extra,
	});
}

export function formatWidgetsPreview(
	lines: WidgetLines,
	config: StatuslineConfig = DEFAULT_CONFIG,
): string {
	return formatWidgetsPreviewLines(lines, config).join(" / ");
}

/** Mock preview lines using PREVIEW_SNAPSHOT so empty live data still shows chrome. */
export function formatWidgetsPreviewLines(
	lines: WidgetLines,
	config: StatuslineConfig = DEFAULT_CONFIG,
): string[] {
	const previewConfig: StatuslineConfig = {
		...config,
		lines: {
			line0: [...lines.line0],
			line1: [...lines.line1],
			line2: [...lines.line2],
			line3: [...lines.line3],
			line4: [...lines.line4],
		},
	};
	const segments = buildWidgetSegments(PREVIEW_SNAPSHOT, previewConfig);
	if (segments.length === 0) return ["(none)"];
	const separator = formatWidgetSeparator(previewConfig.spacing, previewConfig.separator ?? "dot");
	const groups = groupSegmentsByLines(segments, previewConfig).filter((group) => group.length > 0);
	return groups.length > 0
		? groups.map((group) => group.map((segment) => segment.text).join(separator))
		: ["(empty)"];
}

export function buildWidgetSegments(snapshot: StatusSnapshot, config: StatuslineConfig): WidgetSegment[] {
	const segments: WidgetSegment[] = [];
	const minimal = config.minimal;
	const iconMode = config.iconMode ?? DEFAULT_CONFIG.iconMode;

	for (const id of enabledWidgets(config)) {
		const priority = WIDGET_PRIORITY[id] ?? 50;
		switch (id) {
			case "path": {
				const body = formatPathContent(snapshot.cwd, iconMode);
				pushContent(segments, id, "path", body, priority);
				break;
			}
			case "session":
				if (snapshot.sessionName) {
					const sessionName = formatSessionName(snapshot.sessionName);
					segments.push({
						id,
						accent: "session",
						text: sessionName,
						parts: [{ text: sessionName, tone: "muted" }],
						priority,
					});
				}
				break;
			case "model":
				pushContent(
					segments,
					id,
					"model",
					formatModelContent(snapshot.modelId, snapshot.thinkingLevel, snapshot.hasReasoning),
					priority,
				);
				break;
			case "mode":
				if (snapshot.mode) {
					pushContent(segments, id, "state", formatModeContent(snapshot.mode), priority);
				}
				break;
			case "fast": {
				const body = formatFastBadge(snapshot.fast, iconMode);
				if (body) pushContent(segments, id, "state", body, priority);
				break;
			}
			case "tokens": {
				if (minimal) {
					pushContent(
						segments,
						id,
						"usage",
						formatTokenPairMinimal(snapshot.tokens.input, snapshot.tokens.output, iconMode),
						priority,
					);
				} else {
					const input = formatTokenDirection("in", snapshot.tokens.input, iconMode);
					const output = formatTokenDirection("out", snapshot.tokens.output, iconMode);
					const separator = formatWidgetSeparator(config.spacing);
					const parts = [...input.parts, { text: separator, tone: "dim" as const }, ...output.parts];
					pushContent(
						segments,
						id,
						"usage",
						{ text: parts.map((part) => part.text).join(""), parts },
						priority,
					);
				}
				break;
			}
			case "cache": {
				const body = formatCache(snapshot.tokens, minimal, iconMode);
				if (body) pushContent(segments, id, "usage", body, priority);
				break;
			}
			case "cost": {
				if (snapshot.cost > 0) {
					pushContent(segments, id, "usage", formatCost(snapshot.cost, minimal), priority);
				}
				break;
			}
			case "context": {
				const body = formatContextText(snapshot.context?.percent, config.contextMode, minimal, iconMode)
					?? formatContextUnavailable(minimal, iconMode);
				pushContent(segments, id, "usage", body, priority);
				break;
			}
			case "contextBar": {
				const percent = snapshot.context?.percent;
				const body = formatContextBar(percent, config.contextBarWidth, config.contextMode, minimal, iconMode);
				if (!body || percent === null || percent === undefined || Number.isNaN(percent)) {
					pushContent(segments, id, "neutral", formatContextUnavailable(minimal, iconMode), priority);
					break;
				}
				pushContent(segments, id, "neutral", body, priority, {
					bar: {
						width: Math.max(
							MIN_CONTEXT_BAR_WIDTH,
							Math.min(MAX_CONTEXT_BAR_WIDTH, Math.floor(config.contextBarWidth || DEFAULT_CONFIG.contextBarWidth)),
						),
						minWidth: MIN_CONTEXT_BAR_WIDTH,
						rebuild: (width) => formatContextBar(percent, width, config.contextMode, minimal, iconMode) ?? body,
					},
				});
				break;
			}
			case "branch":
				if (snapshot.branch) {
					pushContent(segments, id, "branch", formatBranch(snapshot.branch, iconMode), priority);
				}
				break;
			case "branchDiff":
				if (snapshot.branchDiff) {
					const body = formatBranchDiff(snapshot.branchDiff);
					if (body) pushContent(segments, id, "branch", body, priority);
				}
				break;
			case "progress":
				if (snapshot.progress) {
					segments.push({
						id,
						accent: "progress",
						text: snapshot.progress,
						parts: [{ text: snapshot.progress, tone: "active" }],
						priority,
					});
				}
				break;
			case "duration":
				if (snapshot.duration) {
					const pair = formatDurationPair(
						snapshot.duration.roundMs,
						snapshot.duration.sessionMs,
						minimal,
					);
					pushContent(segments, id, "usage", formatDurationContent(pair, iconMode, minimal), priority);
				}
				break;
			case "state": {
				const tone = snapshot.runState === "Ready"
					? "dim"
					: snapshot.runState === "Thinking"
						? thinkingLevelTone(snapshot.thinkingLevel)
						: snapshot.runState === "Waiting"
							? "muted"
							: "active";
				segments.push({
					id,
					accent: "state",
					text: snapshot.runState,
					parts: [{ text: snapshot.runState, tone }],
					priority,
				});
				break;
			}
			case "quota": {
				if (!snapshot.quota) {
					if (snapshot.quotaStatus === "loading") {
						pushContent(segments, id, "neutral", {
							text: "Usage …",
							parts: [{ text: "Usage ", tone: "label" }, { text: "…", tone: "dim" }],
						}, priority);
					} else if (snapshot.quotaStatus === "error") {
						pushContent(segments, id, "neutral", {
							text: "Usage unavailable",
							parts: [{ text: "Usage ", tone: "label" }, { text: "unavailable", tone: "error" }],
						}, priority);
					}
					break;
				}
				const body = formatQuota(snapshot.quota, iconMode, 6);
				if (!body) break;
				pushContent(segments, id, "neutral", body, priority, {
					bar: {
						width: 6,
						minWidth: 4,
						rebuild: (width) => formatQuota(snapshot.quota!, iconMode, width) ?? body,
					},
				});
				break;
			}
			case "environment":
				if (snapshot.environment) {
					pushContent(segments, id, "dim", formatEnvironment(snapshot.environment), priority);
				}
				break;
			case "toolActivity": {
				if (!snapshot.toolActivity) break;
				const body = formatToolActivity(
					snapshot.toolActivity,
					iconMode,
					config.toolActivityMode ?? "detailed",
				);
				if (body) {
					const hasActiveOrError = Object.values(snapshot.toolActivity).some(
						(entry) => entry.active > 0 || entry.error > 0,
					);
					pushContent(segments, id, "progress", body, hasActiveOrError ? 4 : priority);
				}
				break;
			}
			case "worktree":
				if (snapshot.worktree) pushContent(segments, id, "branch", formatWorktree(snapshot.worktree, iconMode), priority);
				break;
			case "runtime":
				if (snapshot.runtime) pushContent(segments, id, "neutral", formatRuntime(snapshot.runtime, iconMode), priority);
				break;
			case "runTps":
			case "runTtft":
			case "runDuration":
			case "runTokens":
			case "runStalls":
			case "runCostRate": {
				if (!snapshot.performance) break;
				const body = formatRunMetric(snapshot.performance, id, iconMode);
				if (body) pushContent(segments, id, "usage", body, priority);
				break;
			}
		}
	}

	return segments;
}
