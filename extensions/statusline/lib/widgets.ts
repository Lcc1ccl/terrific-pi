import { DEFAULT_CONFIG } from "./config.ts";
import { formatDurationPair } from "./duration.ts";
import {
	formatBranchDiff,
	formatCache,
	formatContextBar,
	formatContextText,
	formatCost,
	formatCwd,
	formatTokensCompact,
} from "./format.ts";
import { formatWidgetSeparator } from "./render.ts";
import type { RunState, StatusSnapshot, StatuslineConfig, WidgetId, WidgetSegment } from "./types.ts";

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
	fast: "⚡",
	tokens: { input: 1500, output: 800, cacheRead: 4000, cacheWrite: 500 },
	cost: 0.42,
	context: { tokens: 40_000, contextWindow: 100_000, percent: 40 },
	branch: "main",
	branchDiff: { additions: 12, deletions: 3 },
	progress: "task 1/2",
	duration: { roundMs: 12_300, sessionMs: 105_000 },
	runState: "Ready",
};

export function formatWidgetsPreview(
	enabled: readonly string[],
	spacing = DEFAULT_CONFIG.spacing,
): string {
	const widgets = enabled.filter((id): id is WidgetId => typeof id === "string");
	if (widgets.length === 0) return "(none)";
	const segments = buildWidgetSegments(PREVIEW_SNAPSHOT, {
		...DEFAULT_CONFIG,
		widgets,
	});
	return segments.map((segment) => segment.text).join(formatWidgetSeparator(spacing)) || "(empty)";
}

export function buildWidgetSegments(snapshot: StatusSnapshot, config: StatuslineConfig): WidgetSegment[] {
	const segments: WidgetSegment[] = [];
	const minimal = config.minimal;

	for (const id of config.widgets) {
		switch (id) {
			case "path":
				segments.push({ id, accent: "path", text: formatCwd(snapshot.cwd) });
				break;
			case "session":
				if (snapshot.sessionName) {
					segments.push({ id, accent: "session", text: snapshot.sessionName });
				}
				break;
			case "model": {
				const text = snapshot.hasReasoning && snapshot.thinkingLevel !== "off"
					? `${snapshot.modelId} ${snapshot.thinkingLevel}`
					: snapshot.modelId;
				segments.push({ id, accent: "model", text });
				break;
			}
			case "mode":
				if (snapshot.mode) {
					segments.push({ id, accent: "state", text: snapshot.mode });
				}
				break;
			case "fast":
				if (snapshot.fast) {
					segments.push({ id, accent: "state", text: snapshot.fast });
				}
				break;
			case "tokens": {
				const input = formatTokensCompact(snapshot.tokens.input);
				const output = formatTokensCompact(snapshot.tokens.output);
				segments.push({
					id,
					accent: "usage",
					text: minimal ? `⬆️${input}/⬇️${output}` : `⬆️${input}`,
				});
				if (!minimal) {
					segments.push({
						id,
						accent: "usage",
						text: `⬇️${output}`,
					});
				}
				break;
			}
			case "cache": {
				const text = formatCache(snapshot.tokens, minimal);
				if (text) segments.push({ id, accent: "usage", text });
				break;
			}
			case "cost":
				if (snapshot.cost > 0) {
					segments.push({ id, accent: "usage", text: formatCost(snapshot.cost, minimal) });
				}
				break;
			case "context": {
				const text = formatContextText(snapshot.context?.percent, config.contextMode, minimal);
				if (text) segments.push({ id, accent: "usage", text });
				break;
			}
			case "contextBar": {
				const text = formatContextBar(
					snapshot.context?.percent,
					config.contextBarWidth,
					config.contextMode,
				);
				if (text) segments.push({ id, accent: "usage", text });
				break;
			}
			case "branch":
				if (snapshot.branch) {
					segments.push({ id, accent: "branch", text: snapshot.branch === "main" ? "🏠" : snapshot.branch });
				}
				break;
			case "branchDiff":
				if (snapshot.branchDiff) {
					const text = formatBranchDiff(snapshot.branchDiff);
					if (text) segments.push({ id, accent: "branch", text });
				}
				break;
			case "progress":
				if (snapshot.progress) segments.push({ id, accent: "progress", text: snapshot.progress });
				break;
			case "duration":
				if (snapshot.duration) {
					segments.push({
						id,
						accent: "usage",
						text: formatDurationPair(snapshot.duration.roundMs, snapshot.duration.sessionMs, minimal),
					});
				}
				break;
			case "state":
				segments.push({ id, accent: "state", text: snapshot.runState });
				break;
		}
	}

	return segments;
}
