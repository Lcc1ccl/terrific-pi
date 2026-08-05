import type { RuntimeInfo } from "./runtime-info.ts";
import type { TurnPerformanceView } from "./telemetry.ts";
import type { WorktreeInfo } from "./worktree.ts";

export type RunState = "Ready" | "Working" | "Thinking" | "Waiting";

export type StatuslineLayout = "single" | "stacked";
export type IconMode = "emoji" | "plain" | "nerd" | "ascii" | "auto";
export type StatuslineSeparator = "dot" | "bar";
export type ToolActivityMode = "detailed" | "compact";

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
	| "performance";

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

export type WidgetGroup = "project" | "usage" | "environment" | "activity";

/** Display / stacked-line order for widget groups. */
export const WIDGET_GROUP_ORDER: readonly WidgetGroup[] = [
	"project",
	"usage",
	"environment",
	"activity",
] as const;

/** Semantic groups for stacked layout. session/mode share environment line but stay independent widgets. */
export const WIDGET_GROUPS: Record<WidgetId, WidgetGroup> = {
	path: "project",
	model: "project",
	branch: "project",
	branchDiff: "project",
	fast: "project",
	context: "usage",
	contextBar: "usage",
	tokens: "usage",
	cache: "usage",
	cost: "usage",
	quota: "usage",
	session: "environment",
	mode: "environment",
	environment: "environment",
	runtime: "environment",
	toolActivity: "activity",
	progress: "activity",
	duration: "activity",
	state: "activity",
	worktree: "project",
	performance: "usage",
};

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
	performance: 78,
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

export interface TelemetryConfig {
	display: "off" | "widget" | "notification";
	tps: boolean;
	ttft: boolean;
	duration: boolean;
	tokens: boolean;
	stalls: boolean;
	cost: boolean;
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
	widgets: WidgetId[];
	layout: StatuslineLayout;
	iconMode: IconMode;
	contextMode: ContextMode;
	contextBarWidth: number;
	minimal: boolean;
	separator: StatuslineSeparator;
	spacing: number;
	/** detailed = per-tool; compact = core_tools + aux_tools aggregates. */
	toolActivityMode: ToolActivityMode;
	telemetry?: TelemetryConfig;
	/** Optional stacked-line group overrides (defaults live in WIDGET_GROUPS). */
	widgetGroups?: Partial<Record<WidgetId, WidgetGroup>>;
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
