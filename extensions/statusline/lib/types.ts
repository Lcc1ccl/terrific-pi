export type RunState = "Ready" | "Working" | "Thinking";

export type WidgetId =
	| "path"
	| "session"
	| "model"
	| "mode"
	| "tokens"
	| "cache"
	| "cost"
	| "context"
	| "contextBar"
	| "branch"
	| "branchDiff"
	| "progress"
	| "duration"
	| "state";

export type ContextMode = "remaining" | "used";

export type Accent = "model" | "path" | "branch" | "state" | "usage" | "progress" | "session";

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

export interface StatusSnapshot {
	cwd: string;
	sessionName?: string;
	modelId: string;
	thinkingLevel: string;
	hasReasoning: boolean;
	/** Optional execution mode badge from pi-essentials (/mode). */
	mode?: string;
	tokens: TokenTotals;
	cost: number;
	context?: ContextUsageView;
	branch?: string | null;
	branchDiff?: BranchChangeStats;
	progress?: string;
	/** Current round LLM ms / session total LLM ms (live). */
	duration?: { roundMs: number; sessionMs: number };
	runState: RunState;
}

export interface StatuslineConfig {
	widgets: WidgetId[];
	contextMode: ContextMode;
	contextBarWidth: number;
	minimal: boolean;
	separator: string;
}

export interface WidgetSegment {
	id: WidgetId;
	accent: Accent;
	text: string;
}
