import { DEFAULT_CONFIG } from "./config.ts";
import {
	formatBranchDiff,
	formatCache,
	formatContextBar,
	formatContextText,
	formatCost,
	formatCwd,
	formatTokensCompact,
} from "./format.ts";
import type { StatusSnapshot, StatuslineConfig, WidgetId, WidgetSegment } from "./types.ts";

/** Sample data for the widgets editor preview line. */
export const PREVIEW_SNAPSHOT: StatusSnapshot = {
	cwd: "/home/user/proj",
	sessionName: "session",
	modelId: "model",
	thinkingLevel: "high",
	hasReasoning: true,
	tokens: { input: 1500, output: 800, cacheRead: 4000, cacheWrite: 500 },
	cost: 0.42,
	context: { tokens: 40_000, contextWindow: 100_000, percent: 40 },
	branch: "main",
	branchDiff: { additions: 12, deletions: 3 },
	progress: "task 1/2",
	runState: "Ready",
};

export function formatWidgetsPreview(
	enabled: readonly string[],
	separator = DEFAULT_CONFIG.separator,
): string {
	const widgets = enabled.filter((id): id is WidgetId => typeof id === "string");
	if (widgets.length === 0) return "(none)";
	const segments = buildWidgetSegments(PREVIEW_SNAPSHOT, {
		...DEFAULT_CONFIG,
		widgets,
	});
	return segments.map((segment) => segment.text).join(separator) || "(empty)";
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
			case "tokens": {
				const input = formatTokensCompact(snapshot.tokens.input);
				const output = formatTokensCompact(snapshot.tokens.output);
				segments.push({
					id,
					accent: "usage",
					text: minimal ? `${input}/${output}` : `${input} in`,
				});
				if (!minimal) {
					segments.push({
						id,
						accent: "usage",
						text: `${output} out`,
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
					minimal,
				);
				if (text) segments.push({ id, accent: "usage", text });
				break;
			}
			case "branch":
				if (snapshot.branch) segments.push({ id, accent: "branch", text: snapshot.branch });
				break;
			case "branchDiff":
				if (snapshot.branchDiff) {
					segments.push({ id, accent: "branch", text: formatBranchDiff(snapshot.branchDiff) });
				}
				break;
			case "progress":
				if (snapshot.progress) segments.push({ id, accent: "progress", text: snapshot.progress });
				break;
			case "state":
				segments.push({ id, accent: "state", text: snapshot.runState });
				break;
		}
	}

	return segments;
}
