import {
	DEFAULT_CONFIG,
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
	formatCost,
	formatCwd,
	formatDurationContent,
	formatSessionName,
	formatEnvironment,
	formatFastBadge,
	formatModeContent,
	formatModelContent,
	formatQuota,
	appendAuxTokenExtras,
	formatTokenDirection,
	formatTokenPairMinimal,
	formatToolActivity,
	thinkingLevelTone,
	type SegmentContent,
} from "./format.ts";
import { formatWidgetSeparator, stripTerminalControls } from "./render.ts";
import type {
	RunState,
	StatusSnapshot,
	StatuslineConfig,
	WidgetId,
	WidgetSegment,
} from "./types.ts";
import { WIDGET_PRIORITY } from "./types.ts";

/** Extension status keys that have dedicated widgets or live in process-view. */
export const EXCLUDED_PROGRESS_KEYS = new Set(["ponytail", "pi-essentials-mode", "fast", "process", "auxiliary"]);

/** Metadata-only tools that should not appear in footer activity. */
export const EXCLUDED_TOOL_ACTIVITY_NAMES = new Set(["process_update"]);

export function shouldTrackToolActivity(toolName: string): boolean {
	return !EXCLUDED_TOOL_ACTIVITY_NAMES.has(toolName);
}

/** Status key written by pi-essentials /mode. */
export const MODE_STATUS_KEY = "pi-essentials-mode";

/** Status key written by /fast. */
export const FAST_STATUS_KEY = "fast";

/** Status key written by process-view while waiting/blocked. */
export const PROCESS_STATUS_KEY = "process";

export function runStateForAssistantEvent(type: string): RunState | undefined {
	if (type.startsWith("thinking_")) return "Thinking";
	if (type.startsWith("text_") || type.startsWith("toolcall_")) return "Working";
	return undefined;
}

/** Promote Ready → Waiting when process-view is paused on subagent/external work. */
export function resolveRunState(
	runState: RunState,
	extensionStatuses?: ReadonlyMap<string, string> | Iterable<readonly [string, string]>,
): RunState {
	if (runState !== "Ready" || !extensionStatuses) return runState;
	const processStatus = extensionStatuses instanceof Map
		? extensionStatuses.get(PROCESS_STATUS_KEY)
		: new Map(extensionStatuses).get(PROCESS_STATUS_KEY);
	const status = processStatus ? sanitizeStatus(processStatus).toLowerCase() : "";
	return status === "waiting" || status === "blocked" ? "Waiting" : runState;
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
	auxUsage: { input: 3700, output: 900, unsplit: 0, tokens: 4_600, cost: 0.03 },
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
	config: StatuslineConfig = DEFAULT_CONFIG,
): string {
	const widgets = enabled.filter((id): id is WidgetId => typeof id === "string");
	if (widgets.length === 0) return "(none)";
	const segments = buildWidgetSegments(PREVIEW_SNAPSHOT, {
		...config,
		widgets,
	});
	return segments
		.map((segment) => segment.text)
		.join(formatWidgetSeparator(config.spacing, config.separator ?? "dot")) || "(empty)";
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
					parts: [{ text: formatCwd(snapshot.cwd), tone: "muted" }],
					priority,
				});
				break;
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
				const auxIn = snapshot.auxUsage?.input ?? 0;
				const auxOut = snapshot.auxUsage?.output ?? 0;
				const auxExtras = {
					unsplit: snapshot.auxUsage?.unsplit ?? 0,
					unknown: Boolean(snapshot.auxUsage?.hasUnknownUsage),
				};
				if (minimal) {
					pushContent(
						segments,
						id,
						"usage",
						formatTokenPairMinimal(
							snapshot.tokens.input,
							snapshot.tokens.output,
							iconMode,
							auxIn,
							auxOut,
							auxExtras,
						),
						priority,
					);
				} else {
					const input = formatTokenDirection("in", snapshot.tokens.input, iconMode, auxIn);
					const output = formatTokenDirection("out", snapshot.tokens.output, iconMode, auxOut);
					const separator = formatWidgetSeparator(config.spacing);
					const parts = [...input.parts, { text: separator, tone: "dim" as const }, ...output.parts];
					appendAuxTokenExtras(parts, {
						input: auxIn,
						output: auxOut,
						...auxExtras,
					});
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
				const auxCost = snapshot.auxUsage?.cost ?? 0;
				const auxUnknownCost = Boolean(snapshot.auxUsage?.hasUnknownCost);
				if (snapshot.cost > 0 || auxCost > 0 || auxUnknownCost) {
					pushContent(
						segments,
						id,
						"usage",
						formatCost(snapshot.cost, minimal, auxCost, auxUnknownCost),
						priority,
					);
				}
				break;
			}
			case "context": {
				const body = formatContextText(snapshot.context?.percent, config.contextMode, minimal)
					?? (minimal
						? { text: "ctx ?", parts: [{ text: "ctx ", tone: "label" }, { text: "?", tone: "dim" }] }
						: { text: "Context ?", parts: [{ text: "Context ", tone: "label" }, { text: "?", tone: "dim" }] });
				pushContent(segments, id, "usage", body, priority);
				break;
			}
			case "contextBar": {
				const percent = snapshot.context?.percent;
				const body = formatContextBar(percent, config.contextBarWidth, config.contextMode, minimal);
				if (!body || percent === null || percent === undefined || Number.isNaN(percent)) {
					pushContent(segments, id, "neutral", minimal
						? { text: "ctx ?", parts: [{ text: "ctx ", tone: "label" }, { text: "?", tone: "dim" }] }
						: {
							text: "Context ?",
							parts: [{ text: "Context ", tone: "label" }, { text: "?", tone: "dim" }],
						}, priority);
					break;
				}
				pushContent(segments, id, "neutral", body, priority, {
					bar: {
						width: Math.max(
							MIN_CONTEXT_BAR_WIDTH,
							Math.min(MAX_CONTEXT_BAR_WIDTH, Math.floor(config.contextBarWidth || DEFAULT_CONFIG.contextBarWidth)),
						),
						minWidth: MIN_CONTEXT_BAR_WIDTH,
						rebuild: (width) => formatContextBar(percent, width, config.contextMode, minimal) ?? body,
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
		}
	}

	return segments;
}
