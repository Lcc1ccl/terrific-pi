import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type {
	ContextMode,
	IconMode,
	StatuslineConfig,
	StatuslineLayout,
	StatuslineSeparator,
	ToolActivityMode,
	WidgetId,
} from "./types.ts";

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

export const DEFAULT_CONFIG: StatuslineConfig = {
	widgets: [
		"path",
		"session",
		"model",
		"fast",
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
	layout: "single",
	iconMode: "emoji",
	contextMode: "remaining",
	contextBarWidth: DEFAULT_CONTEXT_BAR_WIDTH,
	minimal: false,
	separator: "dot",
	spacing: DEFAULT_WIDGET_SPACING,
	toolActivityMode: "detailed",
};

/**
 * True minimal footer profile: single-line plain chrome + short core widgets.
 * mode/fast stay enabled (render only when active). Task detail stays in process-view.
 */
export const MINIMAL_WIDGETS: WidgetId[] = [
	"model",
	"tokens",
	"context",
	"cost",
	"mode",
	"fast",
	"state",
];

export const MINIMAL_PROFILE: StatuslineConfig = {
	widgets: [...MINIMAL_WIDGETS],
	layout: "single",
	iconMode: "plain",
	contextMode: "used",
	contextBarWidth: DEFAULT_CONTEXT_BAR_WIDTH,
	minimal: true,
	separator: "dot",
	spacing: DEFAULT_WIDGET_SPACING,
	toolActivityMode: "compact",
};

export function cloneMinimalProfile(): StatuslineConfig {
	return {
		...MINIMAL_PROFILE,
		widgets: [...MINIMAL_PROFILE.widgets],
	};
}

export function isMinimalProfile(config: StatuslineConfig): boolean {
	return (
		config.minimal
		&& config.layout === MINIMAL_PROFILE.layout
		&& config.iconMode === MINIMAL_PROFILE.iconMode
		&& config.contextMode === MINIMAL_PROFILE.contextMode
		&& config.separator === MINIMAL_PROFILE.separator
		&& config.spacing === MINIMAL_PROFILE.spacing
		&& config.toolActivityMode === MINIMAL_PROFILE.toolActivityMode
		&& config.widgets.length === MINIMAL_PROFILE.widgets.length
		&& config.widgets.every((id, index) => id === MINIMAL_PROFILE.widgets[index])
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asWidgetIds(value: unknown): WidgetId[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const widgets = value.filter((item): item is WidgetId => typeof item === "string" && WIDGET_ID_SET.has(item));
	return [...new Set(widgets)];
}

function asContextMode(value: unknown): ContextMode | undefined {
	return value === "remaining" || value === "used" ? value : undefined;
}

function asLayout(value: unknown): StatuslineLayout | undefined {
	return value === "single" || value === "stacked" ? value : undefined;
}

function asIconMode(value: unknown): IconMode | undefined {
	return value === "emoji" || value === "plain" ? value : undefined;
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

export function mergeStatuslineConfig(raw: unknown): StatuslineConfig {
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG, widgets: [...DEFAULT_CONFIG.widgets] };

	const widgets = asWidgetIds(raw.widgets);
	const layout = asLayout(raw.layout);
	const iconMode = asIconMode(raw.iconMode);
	const contextMode = asContextMode(raw.contextMode);
	const contextBarWidth = asContextBarWidth(raw.contextBarWidth);
	const minimal = typeof raw.minimal === "boolean" ? raw.minimal : undefined;
	const separator = asSeparator(raw.separator);
	const spacing = asWidgetSpacing(raw.spacing);
	const toolActivityMode = asToolActivityMode(raw.toolActivityMode);

	return {
		widgets: widgets && widgets.length > 0 ? widgets : [...DEFAULT_CONFIG.widgets],
		layout: layout ?? DEFAULT_CONFIG.layout,
		iconMode: iconMode ?? DEFAULT_CONFIG.iconMode,
		contextMode: contextMode ?? DEFAULT_CONFIG.contextMode,
		contextBarWidth: contextBarWidth ?? DEFAULT_CONFIG.contextBarWidth,
		minimal: minimal ?? DEFAULT_CONFIG.minimal,
		separator: separator ?? DEFAULT_CONFIG.separator,
		spacing: spacing ?? DEFAULT_CONFIG.spacing,
		toolActivityMode: toolActivityMode ?? DEFAULT_CONFIG.toolActivityMode,
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
		widgets: [...config.widgets],
		layout: config.layout,
		iconMode: config.iconMode,
		contextMode: config.contextMode,
		contextBarWidth: config.contextBarWidth,
		minimal: config.minimal,
		separator: config.separator ?? DEFAULT_CONFIG.separator,
		spacing: config.spacing,
		toolActivityMode: config.toolActivityMode ?? DEFAULT_CONFIG.toolActivityMode,
	};
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
