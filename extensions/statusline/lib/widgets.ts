import { DEFAULT_CONFIG } from "./config.ts";
import { formatDurationPair } from "./duration.ts";
import {
	formatBranch,
	formatBranchDiff,
	formatCache,
	formatContextBar,
	formatContextText,
	formatCost,
	formatCwd,
	formatDurationContent,
	formatEnvironment,
	formatFastBadge,
	formatModelContent,
	formatQuota,
	formatTokenDirection,
	formatTokenPairMinimal,
	formatToolActivity,
	type SegmentContent,
} from "./format.ts";
import { formatWidgetSeparator } from "./render.ts";
import type {
	RunState,
	StatusSnapshot,
	StatuslineConfig,
	WidgetId,
	WidgetSegment,
} from "./types.ts";
import { WIDGET_PRIORITY } from "./types.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Extension status keys that are badges, not task progress. */
export const EXCLUDED_PROGRESS_KEYS = new Set(["ponytail", "pi-essentials-mode", "fast"]);

/** Status key written by pi-essentials /mode. */
export const MODE_STATUS_KEY = "pi-essentials-mode";

/** Status key written by /fast. */
export const FAST_STATUS_KEY = "fast";

export function runStateForAssistantEvent(type: string): RunState | undefined {
	if (type.startsWith("thinking_")) return "Thinking";
	if (type.startsWith("text_") || type.startsWith("toolcall_")) return "Working";
	return undefined;
}

export function sanitizeStatus(text: string): string {
	return text
		.replace(ANSI_PATTERN, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
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
	enabled: readonly string[],
	spacing = DEFAULT_CONFIG.spacing,
	iconMode = DEFAULT_CONFIG.iconMode,
): string {
	const widgets = enabled.filter((id): id is WidgetId => typeof id === "string");
	if (widgets.length === 0) return "(none)";
	const segments = buildWidgetSegments(PREVIEW_SNAPSHOT, {
		...DEFAULT_CONFIG,
		widgets,
		iconMode,
	});
	return segments.map((segment) => segment.text).join(formatWidgetSeparator(spacing)) || "(empty)";
}

export function buildWidgetSegments(snapshot: StatusSnapshot, config: StatuslineConfig): WidgetSegment[] {
	const segments: WidgetSegment[] = [];
	const minimal = config.minimal;
	const iconMode = config.iconMode ?? "emoji";

	for (const id of config.widgets) {
		const priority = WIDGET_PRIORITY[id] ?? 50;
		switch (id) {
			case "path":
				segments.push({
					id,
					accent: "path",
					text: formatCwd(snapshot.cwd),
					parts: [{ text: formatCwd(snapshot.cwd), tone: "value" }],
					priority,
				});
				break;
			case "session":
				if (snapshot.sessionName) {
					segments.push({
						id,
						accent: "session",
						text: snapshot.sessionName,
						parts: [{ text: snapshot.sessionName, tone: "value" }],
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
					segments.push({
						id,
						accent: "state",
						text: snapshot.mode,
						parts: [{ text: snapshot.mode, tone: "value" }],
						priority,
					});
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
					pushContent(
						segments,
						id,
						"usage",
						formatTokenDirection("in", snapshot.tokens.input, iconMode),
						priority,
					);
					pushContent(
						segments,
						id,
						"usage",
						formatTokenDirection("out", snapshot.tokens.output, iconMode),
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
			case "cost":
				if (snapshot.cost > 0) {
					pushContent(segments, id, "usage", formatCost(snapshot.cost, minimal), priority);
				}
				break;
			case "context": {
				const body = formatContextText(snapshot.context?.percent, config.contextMode, minimal);
				if (body) pushContent(segments, id, "usage", body, priority);
				break;
			}
			case "contextBar": {
				const percent = snapshot.context?.percent;
				const body = formatContextBar(percent, config.contextBarWidth, config.contextMode);
				if (body && percent !== null && percent !== undefined && !Number.isNaN(percent)) {
					pushContent(segments, id, "neutral", body, priority, {
						bar: {
							width: Math.max(4, Math.min(40, Math.floor(config.contextBarWidth || 10))),
							minWidth: 4,
							rebuild: (width) => formatContextBar(percent, width, config.contextMode) ?? body,
						},
					});
				}
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
						parts: [{ text: snapshot.progress, tone: "value" }],
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
					pushContent(segments, id, "usage", formatDurationContent(pair, iconMode), priority);
				}
				break;
			case "state":
				segments.push({
					id,
					accent: "state",
					text: snapshot.runState,
					parts: [{ text: snapshot.runState, tone: "value" }],
					priority,
				});
				break;
			case "quota": {
				if (!snapshot.quota) break;
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
				const body = formatToolActivity(snapshot.toolActivity, iconMode);
				if (body) {
					const hasActiveOrError = Object.values(snapshot.toolActivity).some(
						(entry) => entry.active > 0 || entry.error > 0,
					);
					pushContent(segments, id, "progress", body, hasActiveOrError ? 20 : priority);
				}
				break;
			}
		}
	}

	return segments;
}
