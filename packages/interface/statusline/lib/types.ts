import type { RuntimeInfo } from "./runtime-info.ts";
import type { TurnPerformanceView } from "./telemetry.ts";
import type { WorktreeInfo } from "./worktree.ts";

export type RunState = "Ready" | "Working" | "Thinking" | "Waiting";

export type IconMode = "emoji" | "plain" | "nerd" | "ascii" | "auto";
export type StatuslineSeparator = "dot" | "bar";
export type ToolActivityMode = "detailed" | "compact";

export const WIDGET_LINE_IDS = ["line0", "line1", "line2", "line3", "line4"] as const;
export type WidgetLineId = (typeof WIDGET_LINE_IDS)[number];

export const RUN_METRIC_WIDGET_IDS = [
	"runTps",
	"runTtft",
	"runDuration",
	"runTokens",
	"runStalls",
	"runCostRate",
] as const;

export type RunMetricWidgetId = (typeof RUN_METRIC_WIDGET_IDS)[number];

export type WidgetId =
	| "path"
	| "session"
	| "model"
	| "mode"
	| "fast"
	| "tokens"
	| "cache"
	| "cost"
	| "context"
	| "contextBar"
	| "branch"
	| "branchDiff"
	| "progress"
	| "duration"
	| "state"
	| "quota"
	| "environment"
	| "toolActivity"
	| "worktree"
	| "runtime"
	| RunMetricWidgetId;

export type ContextMode = "remaining" | "used";

export type Accent =
	| "model"
	| "path"
	| "branch"
	| "state"
	| "usage"
	| "progress"
	| "session"
	| "dim"
	| "neutral";

/** Semantic tone mapped to the active pi theme at render time. */
export type SegmentTone =
	| "icon"
	| "label"
	| "value"
	| "muted"
	| "dim"
	| "active"
	| "error"
	| "success"
	| "warn"
	| "bar"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax";

export interface SegmentPart {
	text: string;
	tone?: SegmentTone;
}

export type WidgetLines = Record<WidgetLineId, WidgetId[]>;

/** Drop order: higher first. Keep model/branch/current-context/state longer. */
export const WIDGET_PRIORITY: Record<WidgetId, number> = {
	session: 90,
	cost: 85,
	duration: 80,
	cache: 70,
	progress: 65,
	toolActivity: 60,
	tokens: 55,
	environment: 50,
	path: 40,
	mode: 35,
	fast: 30,
	branchDiff: 25,
	context: 20,
	contextBar: 15,
	quota: 22,
	branch: 10,
	model: 8,
	state: 5,
	worktree: 28,
	runtime: 75,
	runTps: 78,
	runTtft: 78,
	runDuration: 78,
	runTokens: 78,
	runStalls: 78,
	runCostRate: 78,
};

export type QuotaProvider = "codex" | "claude";
export type QuotaStatus = "idle" | "loading" | "ready" | "error";

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface BranchChangeStats {
	additions: number;
	deletions: number;
}

export interface ContextUsageView {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface QuotaWindow {
	id: string;
	label: string;
	usedPercent: number;
	resetsAt?: number;
	windowSeconds?: number;
}

export interface QuotaSnapshot {
	provider: QuotaProvider;
	modelBucket?: string;
	windows: QuotaWindow[];
	capturedAt: number;
	stale: boolean;
}

export interface EnvironmentCounts {
	contextFiles: number;
	skills: number;
	tools: number;
}

export interface ToolActivity {
	active: number;
	success: number;
	error: number;
}

/** Auxiliary usage folded into main tokens/cost widgets as dim Ⅰ suffixes. */
export interface AuxiliaryUsageView {
	input: number;
	output: number;
	/** Combined totals with no input/output split (e.g. research token count). */
	unsplit: number;
	/** Sum of totalTokens across aux calls. */
	tokens: number;
	/** Known aux cost sum (0 when none reported). */
	cost: number;
	/** At least one successful call exposed no public token usage contract. */
	hasUnknownUsage?: boolean;
	/** At least one successful call omitted cost while others may still report it. */
	hasUnknownCost?: boolean;
}

export interface StatusSnapshot {
	cwd: string;
	sessionName?: string;
	modelId: string;
	thinkingLevel: string;
	hasReasoning: boolean;
	/** Optional execution mode badge from /mode. */
	mode?: string;
	/** Optional priority-processing badge from /fast. */
	fast?: string;
	tokens: TokenTotals;
	cost: number;
	/** Task-scoped auxiliary usage rendered as dim Ⅰ suffixes on tokens/cost. */
	auxUsage?: AuxiliaryUsageView;
	context?: ContextUsageView;
	branch?: string | null;
	branchDiff?: BranchChangeStats;
	progress?: string;
	/** Current parent-agent round ms / current-process active ms (live). */
	duration?: { roundMs: number; sessionMs: number };
	runState: RunState;
	quota?: QuotaSnapshot;
	quotaStatus?: QuotaStatus;
	environment?: EnvironmentCounts;
	/** Aggregated by tool name. */
	toolActivity?: Record<string, ToolActivity>;
	worktree?: WorktreeInfo;
	runtime?: RuntimeInfo;
	performance?: TurnPerformanceView;
}

export interface StatuslineConfig {
	lines: WidgetLines;
	iconMode: IconMode;
	contextMode: ContextMode;
	contextBarWidth: number;
	minimal: boolean;
	separator: StatuslineSeparator;
	spacing: number;
	/** detailed = per-tool; compact = core_tools + aux_tools aggregates. */
	toolActivityMode: ToolActivityMode;
	/** Notify once after each settled agent run. */
	runNotification?: boolean;
}

export interface WidgetSegment {
	id: WidgetId;
	accent: Accent;
	text: string;
	/** Optional dual-tone parts; `text` must equal joined part texts. */
	parts?: SegmentPart[];
	/** Higher values are dropped first when the line is too narrow. Default 50. */
	priority?: number;
	/** Optional bar rebuild for responsive narrowing. */
	bar?: {
		width: number;
		minWidth: number;
		rebuild: (width: number) => string | { text: string; parts?: SegmentPart[] };
	};
}
