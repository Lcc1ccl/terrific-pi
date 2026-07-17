import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ContextMode, StatuslineConfig, WidgetId } from "./types.ts";

export const WIDGET_IDS = [
	"path",
	"session",
	"model",
	"mode",
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
] as const satisfies readonly WidgetId[];

const WIDGET_ID_SET = new Set<string>(WIDGET_IDS);

export const DEFAULT_WIDGET_SPACING = 1;
export const MIN_WIDGET_SPACING = 0;
export const MAX_WIDGET_SPACING = 4;

export const DEFAULT_CONFIG: StatuslineConfig = {
	widgets: [
		"path",
		"session",
		"model",
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
	contextMode: "remaining",
	contextBarWidth: 10,
	minimal: false,
	spacing: DEFAULT_WIDGET_SPACING,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asWidgetIds(value: unknown): WidgetId[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const widgets = value.filter((item): item is WidgetId => typeof item === "string" && WIDGET_ID_SET.has(item));
	return widgets;
}

function asContextMode(value: unknown): ContextMode | undefined {
	return value === "remaining" || value === "used" ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const rounded = Math.floor(value);
	return rounded > 0 ? rounded : undefined;
}

function asWidgetSpacing(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
	return value >= MIN_WIDGET_SPACING && value <= MAX_WIDGET_SPACING ? value : undefined;
}

export function mergeStatuslineConfig(raw: unknown): StatuslineConfig {
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG, widgets: [...DEFAULT_CONFIG.widgets] };

	const widgets = asWidgetIds(raw.widgets);
	const contextMode = asContextMode(raw.contextMode);
	const contextBarWidth = asPositiveInt(raw.contextBarWidth);
	const minimal = typeof raw.minimal === "boolean" ? raw.minimal : undefined;
	const spacing = asWidgetSpacing(raw.spacing);

	return {
		widgets: widgets && widgets.length > 0 ? widgets : [...DEFAULT_CONFIG.widgets],
		contextMode: contextMode ?? DEFAULT_CONFIG.contextMode,
		contextBarWidth: contextBarWidth ?? DEFAULT_CONFIG.contextBarWidth,
		minimal: minimal ?? DEFAULT_CONFIG.minimal,
		spacing: spacing ?? DEFAULT_CONFIG.spacing,
	};
}

export function loadStatuslineConfig(path: string): StatuslineConfig {
	try {
		if (!existsSync(path)) return mergeStatuslineConfig({});
		const text = readFileSync(path, "utf8");
		return mergeStatuslineConfig(JSON.parse(text));
	} catch {
		return mergeStatuslineConfig({});
	}
}

export function saveStatuslineConfig(path: string, config: StatuslineConfig): void {
	const payload: StatuslineConfig = {
		widgets: [...config.widgets],
		contextMode: config.contextMode,
		contextBarWidth: config.contextBarWidth,
		minimal: config.minimal,
		spacing: config.spacing,
	};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
		agentDir: process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent"),
	});
}
