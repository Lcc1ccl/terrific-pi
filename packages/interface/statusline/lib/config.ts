import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type {
	ContextMode,
	IconMode,
	StatuslineConfig,
	StatuslineSeparator,
	ToolActivityMode,
	WidgetId,
	WidgetLineId,
	WidgetLines,
} from "./types.ts";
import { RUN_METRIC_WIDGET_IDS, WIDGET_LINE_IDS } from "./types.ts";

export const WIDGET_IDS = [
	"path",
	"session",
	"model",
	"mode",
	"fast",
	"tokens",
	"cache",
	"cost",
	"context",
	"contextBar",
	"branch",
	"branchDiff",
	"progress",
	"duration",
	"state",
	"quota",
	"environment",
	"toolActivity",
	"worktree",
	"runtime",
	...RUN_METRIC_WIDGET_IDS,
] as const satisfies readonly WidgetId[];

const WIDGET_ID_SET = new Set<string>(WIDGET_IDS);

export const DEFAULT_WIDGET_SPACING = 1;
export const MIN_WIDGET_SPACING = 0;
export const MAX_WIDGET_SPACING = 4;

export const WIDGET_SEPARATOR_GLYPHS = {
	dot: "·",
	bar: "│",
} as const satisfies Record<StatuslineSeparator, string>;

export const DEFAULT_CONTEXT_BAR_WIDTH = 10;
export const MIN_CONTEXT_BAR_WIDTH = 4;
export const MAX_CONTEXT_BAR_WIDTH = 40;

export function emptyWidgetLines(): WidgetLines {
	return { line0: [], line1: [], line2: [], line3: [], line4: [] };
}

export function cloneWidgetLines(lines: WidgetLines): WidgetLines {
	return {
		line0: [...lines.line0],
		line1: [...lines.line1],
		line2: [...lines.line2],
		line3: [...lines.line3],
		line4: [...lines.line4],
	};
}

export function enabledWidgets(config: Pick<StatuslineConfig, "lines">): WidgetId[] {
	return WIDGET_LINE_IDS.flatMap((line) => config.lines[line]);
}

export function hasWidget(config: Pick<StatuslineConfig, "lines">, id: WidgetId): boolean {
	return WIDGET_LINE_IDS.some((line) => config.lines[line].includes(id));
}

export function widgetLineOf(lines: WidgetLines, id: WidgetId): WidgetLineId | undefined {
	return WIDGET_LINE_IDS.find((line) => lines[line].includes(id));
}

export const DEFAULT_LINES: WidgetLines = {
	line0: ["model", "mode", "fast"],
	line1: [
		"path",
		"session",
		"tokens",
		"cache",
		"cost",
		"contextBar",
		"branch",
		"branchDiff",
		"progress",
		"duration",
		"state",
	],
	line2: [],
	line3: [],
	line4: [],
};

export const DEFAULT_CONFIG: StatuslineConfig = {
	lines: cloneWidgetLines(DEFAULT_LINES),
	iconMode: "emoji",
	contextMode: "remaining",
	contextBarWidth: DEFAULT_CONTEXT_BAR_WIDTH,
	minimal: false,
	separator: "dot",
	spacing: DEFAULT_WIDGET_SPACING,
	toolActivityMode: "compact",
	runNotification: false,
};

export const MINIMAL_LINES: WidgetLines = {
	line0: ["model", "mode", "fast"],
	line1: ["path", "session", "branch", "tokens", "cache", "cost", "context", "progress", "state"],
	line2: [],
	line3: [],
	line4: [],
};

export const MINIMAL_WIDGETS: WidgetId[] = WIDGET_LINE_IDS.flatMap((line) => MINIMAL_LINES[line]);

export const MINIMAL_PROFILE: StatuslineConfig = {
	lines: cloneWidgetLines(MINIMAL_LINES),
	iconMode: "plain",
	contextMode: "used",
	contextBarWidth: DEFAULT_CONTEXT_BAR_WIDTH,
	minimal: true,
	separator: "dot",
	spacing: DEFAULT_WIDGET_SPACING,
	toolActivityMode: "compact",
	runNotification: false,
};

export function cloneStatuslineConfig(config: StatuslineConfig): StatuslineConfig {
	return { ...config, lines: cloneWidgetLines(config.lines) };
}

export function cloneMinimalProfile(): StatuslineConfig {
	return cloneStatuslineConfig(MINIMAL_PROFILE);
}

export function isMinimalProfile(config: StatuslineConfig): boolean {
	return (
		config.minimal
		&& config.iconMode === MINIMAL_PROFILE.iconMode
		&& config.contextMode === MINIMAL_PROFILE.contextMode
		&& config.separator === MINIMAL_PROFILE.separator
		&& config.spacing === MINIMAL_PROFILE.spacing
		&& config.toolActivityMode === MINIMAL_PROFILE.toolActivityMode
		&& WIDGET_LINE_IDS.every((line) => (
			config.lines[line].length === MINIMAL_PROFILE.lines[line].length
			&& config.lines[line].every((id, index) => id === MINIMAL_PROFILE.lines[line][index])
		))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asWidgetIds(value: unknown, seen = new Set<WidgetId>()): WidgetId[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const widgets: WidgetId[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !WIDGET_ID_SET.has(item)) continue;
		const id = item as WidgetId;
		if (seen.has(id)) continue;
		seen.add(id);
		widgets.push(id);
	}
	return widgets;
}

function asWidgetLines(value: unknown): WidgetLines | undefined {
	if (!isRecord(value)) return undefined;
	const hasRecognizedArray = WIDGET_LINE_IDS.some((line) => Array.isArray(value[line]));
	if (!hasRecognizedArray) return undefined;
	const lines = emptyWidgetLines();
	const seen = new Set<WidgetId>();
	for (const line of WIDGET_LINE_IDS) lines[line] = asWidgetIds(value[line], seen) ?? [];
	return lines;
}

function asContextMode(value: unknown): ContextMode | undefined {
	return value === "remaining" || value === "used" ? value : undefined;
}

function asIconMode(value: unknown): IconMode | undefined {
	return value === "emoji" || value === "plain" || value === "nerd" || value === "ascii" || value === "auto"
		? value
		: undefined;
}

function asSeparator(value: unknown): StatuslineSeparator | undefined {
	return value === "dot" || value === "bar" ? value : undefined;
}

function asContextBarWidth(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
	return value >= MIN_CONTEXT_BAR_WIDTH && value <= MAX_CONTEXT_BAR_WIDTH ? value : undefined;
}

function asWidgetSpacing(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
	return value >= MIN_WIDGET_SPACING && value <= MAX_WIDGET_SPACING ? value : undefined;
}

function asToolActivityMode(value: unknown): ToolActivityMode | undefined {
	return value === "detailed" || value === "compact" ? value : undefined;
}

type LegacyWidgetGroup = "project" | "usage" | "environment" | "activity";

const LEGACY_DEFAULT_WIDGETS: WidgetId[] = [
	"path", "session", "model", "mode", "fast", "tokens", "cache", "cost", "contextBar",
	"branch", "branchDiff", "progress", "duration", "state",
];

const LEGACY_WIDGET_GROUPS: Record<WidgetId, LegacyWidgetGroup> = {
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
	runTps: "usage",
	runTtft: "usage",
	runDuration: "usage",
	runTokens: "usage",
	runStalls: "usage",
	runCostRate: "usage",
};

const LEGACY_GROUP_LINES: Record<LegacyWidgetGroup, WidgetLineId> = {
	project: "line1",
	usage: "line2",
	environment: "line3",
	activity: "line4",
};

function legacyWidgetGroups(value: unknown): Partial<Record<WidgetId, LegacyWidgetGroup>> {
	if (!isRecord(value)) return {};
	const groups: Partial<Record<WidgetId, LegacyWidgetGroup>> = {};
	for (const [key, rawGroup] of Object.entries(value)) {
		if (!WIDGET_ID_SET.has(key)) continue;
		if (rawGroup !== "project" && rawGroup !== "usage" && rawGroup !== "environment" && rawGroup !== "activity") continue;
		groups[key as WidgetId] = rawGroup;
	}
	return groups;
}

function migrateLegacyLines(raw: Record<string, unknown>): WidgetLines | undefined {
	const widgets = raw.widgets === undefined
		? [...LEGACY_DEFAULT_WIDGETS]
		: asWidgetIds(raw.widgets) ?? [];
	if (widgets.length === 0) return undefined;

	const lines = emptyWidgetLines();
	const stacked = raw.layout === "stacked";
	const overrides = legacyWidgetGroups(raw.widgetGroups);
	for (const id of widgets) {
		if (id === "model" || id === "mode" || id === "fast") {
			lines.line0.push(id);
			continue;
		}
		const line = stacked
			? LEGACY_GROUP_LINES[overrides[id] ?? LEGACY_WIDGET_GROUPS[id]]
			: "line1";
		lines[line].push(id);
	}
	return lines;
}

export function mergeStatuslineConfig(raw: unknown): StatuslineConfig {
	if (!isRecord(raw)) return cloneStatuslineConfig(DEFAULT_CONFIG);

	const parsedLines = asWidgetLines(raw.lines);
	const candidateLines = parsedLines ?? migrateLegacyLines(raw);
	const lines = candidateLines && WIDGET_LINE_IDS.some((line) => candidateLines[line].length > 0)
		? candidateLines
		: cloneWidgetLines(DEFAULT_LINES);
	const iconMode = asIconMode(raw.iconMode);
	const contextMode = asContextMode(raw.contextMode);
	const contextBarWidth = asContextBarWidth(raw.contextBarWidth);
	const minimal = typeof raw.minimal === "boolean" ? raw.minimal : undefined;
	const separator = asSeparator(raw.separator);
	const spacing = asWidgetSpacing(raw.spacing);
	const toolActivityMode = asToolActivityMode(raw.toolActivityMode);
	const runNotification = typeof raw.runNotification === "boolean" ? raw.runNotification : undefined;

	return {
		lines,
		iconMode: iconMode ?? DEFAULT_CONFIG.iconMode,
		contextMode: contextMode ?? DEFAULT_CONFIG.contextMode,
		contextBarWidth: contextBarWidth ?? DEFAULT_CONFIG.contextBarWidth,
		minimal: minimal ?? DEFAULT_CONFIG.minimal,
		separator: separator ?? DEFAULT_CONFIG.separator,
		spacing: spacing ?? DEFAULT_CONFIG.spacing,
		toolActivityMode: toolActivityMode ?? DEFAULT_CONFIG.toolActivityMode,
		runNotification: runNotification ?? DEFAULT_CONFIG.runNotification,
	};
}

export type ConfigLoadResult =
	| { ok: true; value: StatuslineConfig }
	| { ok: false; error: string };

export function loadStatuslineConfigResult(path: string): ConfigLoadResult {
	if (!existsSync(path)) return { ok: true, value: mergeStatuslineConfig({}) };
	try {
		const text = readFileSync(path, "utf8");
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw)) throw new Error("Config root must be a JSON object");
		return { ok: true, value: mergeStatuslineConfig(raw) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Failed to load ${path}: ${message}` };
	}
}

export function saveStatuslineConfig(path: string, config: StatuslineConfig): void {
	const payload: StatuslineConfig = {
		lines: cloneWidgetLines(config.lines),
		iconMode: config.iconMode,
		contextMode: config.contextMode,
		contextBarWidth: config.contextBarWidth,
		minimal: config.minimal,
		separator: config.separator ?? DEFAULT_CONFIG.separator,
		spacing: config.spacing,
		toolActivityMode: config.toolActivityMode ?? DEFAULT_CONFIG.toolActivityMode,
		runNotification: Boolean(config.runNotification),
	};
	if (!config.runNotification) delete payload.runNotification;
	const directory = dirname(path);
	const temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	mkdirSync(directory, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

export function resolveConfigPath(options: {
	explicit?: string;
	envPath?: string;
	agentDir?: string;
}): string {
	if (options.explicit) return options.explicit;
	if (options.envPath) return options.envPath;
	const agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "statusline.json");
}

export function resolveRuntimeConfigPath(explicit?: string): string {
	return resolveConfigPath({
		explicit,
		envPath: process.env.PI_STATUSLINE_CONFIG,
		agentDir: process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"),
	});
}
