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
	formatEnvironment,
	formatFastBadge,
	formatQuota,
	formatTokenDirection,
	formatToolActivity,
	formatTokensCompact,
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
				segments.push({ id, accent: "path", text: formatCwd(snapshot.cwd), priority });
				break;
			case "session":
				if (snapshot.sessionName) {
					segments.push({ id, accent: "session", text: snapshot.sessionName, priority });
				}
				break;
			case "model": {
				const text = snapshot.hasReasoning && snapshot.thinkingLevel !== "off"
					? `${snapshot.modelId} ${snapshot.thinkingLevel}`
					: snapshot.modelId;
				segments.push({ id, accent: "model", text, priority });
				break;
			}
			case "mode":
				if (snapshot.mode) {
					segments.push({ id, accent: "state", text: snapshot.mode, priority });
				}
				break;
			case "fast": {
				const text = formatFastBadge(snapshot.fast, iconMode);
				if (text) {
					segments.push({ id, accent: "state", text, priority });
				}
				break;
			}
			case "tokens": {
				const input = formatTokenDirection("in", snapshot.tokens.input, iconMode);
				const output = formatTokenDirection("out", snapshot.tokens.output, iconMode);
				if (minimal) {
					const left = formatTokensCompact(snapshot.tokens.input);
					const right = formatTokensCompact(snapshot.tokens.output);
					const text = iconMode === "plain"
						? `in ${left}/out ${right}`
						: `${left}/${right}`;
					segments.push({ id, accent: "usage", text, priority });
				} else {
					segments.push({ id, accent: "usage", text: input, priority });
					segments.push({ id, accent: "usage", text: output, priority });
				}
				break;
			}
			case "cache": {
				const text = formatCache(snapshot.tokens, minimal, iconMode);
				if (text) segments.push({ id, accent: "usage", text, priority });
				break;
			}
			case "cost":
				if (snapshot.cost > 0) {
					segments.push({ id, accent: "usage", text: formatCost(snapshot.cost, minimal), priority });
				}
				break;
			case "context": {
				const text = formatContextText(snapshot.context?.percent, config.contextMode, minimal);
				if (text) segments.push({ id, accent: "usage", text, priority });
				break;
			}
			case "contextBar": {
				const percent = snapshot.context?.percent;
				const text = formatContextBar(percent, config.contextBarWidth, config.contextMode);
				if (text && percent !== null && percent !== undefined && !Number.isNaN(percent)) {
					segments.push({
						id,
						accent: "usage",
						text,
						priority,
						bar: {
							width: Math.max(4, Math.min(40, Math.floor(config.contextBarWidth || 10))),
							minWidth: 4,
							rebuild: (width) => formatContextBar(percent, width, config.contextMode) ?? text,
						},
					});
				}
				break;
			}
			case "branch":
				if (snapshot.branch) {
					segments.push({
						id,
						accent: "branch",
						text: formatBranch(snapshot.branch, iconMode),
						priority,
					});
				}
				break;
			case "branchDiff":
				if (snapshot.branchDiff) {
					const text = formatBranchDiff(snapshot.branchDiff);
					if (text) segments.push({ id, accent: "branch", text, priority });
				}
				break;
			case "progress":
				if (snapshot.progress) segments.push({ id, accent: "progress", text: snapshot.progress, priority });
				break;
			case "duration":
				if (snapshot.duration) {
					segments.push({
						id,
						accent: "usage",
						text: formatDurationPair(snapshot.duration.roundMs, snapshot.duration.sessionMs, minimal),
						priority,
					});
				}
				break;
			case "state":
				segments.push({ id, accent: "state", text: snapshot.runState, priority });
				break;
			case "quota": {
				if (!snapshot.quota) break;
				const text = formatQuota(snapshot.quota, iconMode, 6);
				if (!text) break;
				segments.push({
					id,
					accent: "usage",
					text,
					priority,
					bar: {
						width: 6,
						minWidth: 4,
						rebuild: (width) => formatQuota(snapshot.quota!, iconMode, width) ?? text,
					},
				});
				break;
			}
			case "environment":
				if (snapshot.environment) {
					segments.push({
						id,
						accent: "progress",
						text: formatEnvironment(snapshot.environment),
						priority,
					});
				}
				break;
			case "toolActivity": {
				if (!snapshot.toolActivity) break;
				const text = formatToolActivity(snapshot.toolActivity, iconMode);
				if (text) {
					// Prefer keeping active/error over success-only when narrowing.
					const hasActiveOrError = Object.values(snapshot.toolActivity).some(
						(entry) => entry.active > 0 || entry.error > 0,
					);
					segments.push({
						id,
						accent: "progress",
						text,
						priority: hasActiveOrError ? 20 : priority,
					});
				}
				break;
			}
		}
	}

	return segments;
}
