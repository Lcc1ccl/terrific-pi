import {
	MAX_WIDGET_SPACING,
	MIN_WIDGET_SPACING,
	resolveWidgetGroup,
	WIDGET_SEPARATOR_GLYPHS,
} from "./config.ts";
import type {
	Accent,
	SegmentTone,
	StatuslineConfig,
	StatuslineSeparator,
	WidgetGroup,
	WidgetId,
	WidgetSegment,
} from "./types.ts";
import { WIDGET_GROUP_ORDER } from "./types.ts";

export type HostThemeColor =
	| "accent"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax";

export interface HostTheme {
	fg(color: HostThemeColor, text: string): string;
}

export function formatWidgetSeparator(
	spacing: number,
	separator: StatuslineSeparator = "dot",
): string {
	const width = Math.max(MIN_WIDGET_SPACING, Math.min(MAX_WIDGET_SPACING, Math.floor(spacing)));
	const gap = " ".repeat(width);
	const glyph = WIDGET_SEPARATOR_GLYPHS[separator] ?? WIDGET_SEPARATOR_GLYPHS.dot;
	return `${gap}${glyph}${gap}`;
}

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\|$)/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function stripTerminalControls(text: string): string {
	return text
		.replace(OSC_PATTERN, "")
		.replace(ANSI_PATTERN, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(CONTROL_PATTERN, "");
}

/** Fallback visible width when pi-tui helper is not injected. */
export function plainVisibleWidth(text: string): number {
	return stripTerminalControls(text).length;
}

function segmentGroup(
	segment: WidgetSegment,
	groups?: StatuslineConfig["widgetGroups"],
): WidgetGroup {
	return resolveWidgetGroup(segment.id, groups);
}

function hostThemeColor(accent: Accent, tone: SegmentTone = "value"): HostThemeColor {
	switch (tone) {
		case "thinkingOff":
		case "thinkingMinimal":
		case "thinkingLow":
		case "thinkingMedium":
		case "thinkingHigh":
		case "thinkingXhigh":
		case "thinkingMax":
			return tone;
		case "error":
			return "error";
		case "warn":
			return "warning";
		case "success":
			return "success";
		case "active":
			return "accent";
		case "label":
		case "icon":
		case "muted":
			return "muted";
		case "dim":
			return "dim";
		case "value":
		case "bar":
			return "text";
	}
	return accent === "dim" ? "dim" : accent === "progress" ? "accent" : "text";
}

function colorizeText(theme: HostTheme, accent: Accent, text: string, tone: SegmentTone = "value"): string {
	return theme.fg(hostThemeColor(accent, tone), stripTerminalControls(text));
}

function colorizeSegment(theme: HostTheme, segment: WidgetSegment): string {
	if (segment.parts && segment.parts.length > 0) {
		return segment.parts
			.map((part) => colorizeText(theme, segment.accent, part.text, part.tone ?? "value"))
			.join("");
	}
	return colorizeText(theme, segment.accent, segment.text);
}

function colorizeSegments(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	theme: HostTheme,
	indent = "  ",
): string {
	const separator = colorizeText(
		theme,
		"dim",
		formatWidgetSeparator(config.spacing, config.separator ?? "dot"),
		"dim",
	);
	const colored = segments.map((segment) => colorizeSegment(theme, segment));
	return `${indent}${colored.join(separator)}`;
}

function cloneSegments(segments: WidgetSegment[]): WidgetSegment[] {
	return segments.map((segment) => ({
		...segment,
		parts: segment.parts?.map((part) => ({ ...part })),
		bar: segment.bar
			? {
				...segment.bar,
			}
			: undefined,
	}));
}

/**
 * Drop lowest-priority complete segments, shrink bars, then leave final truncate to caller.
 * Never reorders remaining segments.
 */
export function fitSegmentsToWidth(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	theme: HostTheme,
	width: number,
	measure: (text: string) => number,
	indent = "  ",
): WidgetSegment[] {
	const maxWidth = Math.max(1, width);
	let current = cloneSegments(segments);

	const lineWidth = () => measure(colorizeSegments(current, config, theme, indent));
	if (lineWidth() <= maxWidth) return current;

	// 1) Drop high-priority (low importance) segments one by one.
	while (current.length > 1 && lineWidth() > maxWidth) {
		let dropIndex = -1;
		let dropPriority = -1;
		for (let i = 0; i < current.length; i++) {
			const priority = current[i]!.priority ?? 50;
			if (priority > dropPriority) {
				dropPriority = priority;
				dropIndex = i;
			}
		}
		if (dropIndex < 0 || dropPriority < 5) break;
		current = current.filter((_, index) => index !== dropIndex);
	}

	if (lineWidth() <= maxWidth) return current;

	// 2) Shrink bar segments without changing percentages.
	let shrunk = true;
	while (shrunk && lineWidth() > maxWidth) {
		shrunk = false;
		for (const segment of current) {
			if (!segment.bar || segment.bar.width <= segment.bar.minWidth) continue;
			segment.bar.width -= 1;
			const rebuilt = segment.bar.rebuild(segment.bar.width);
			if (typeof rebuilt === "string") {
				segment.text = rebuilt;
				// Drop stale parts after bar rebuild; monochrome rebuild text is fine.
				segment.parts = undefined;
			} else {
				segment.text = rebuilt.text;
				segment.parts = rebuilt.parts;
			}
			shrunk = true;
			if (lineWidth() <= maxWidth) return current;
		}
	}

	return current;
}

export function groupSegmentsBySemantics(
	segments: WidgetSegment[],
	config?: Pick<StatuslineConfig, "widgetGroups">,
): WidgetSegment[][] {
	const order = WIDGET_GROUP_ORDER;
	const grouped = new Map(order.map((group) => [group, [] as WidgetSegment[]]));
	for (const segment of segments) grouped.get(segmentGroup(segment, config?.widgetGroups))!.push(segment);
	return order.map((group) => grouped.get(group)!).filter((group) => group.length > 0);
}

function renderSingleLine(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	theme: HostTheme,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number,
): string {
	const fitted = fitSegmentsToWidth(segments, config, theme, width, measure);
	const separatorEllipsis = colorizeText(theme, "dim", "…", "dim");
	const line = colorizeSegments(fitted, config, theme);
	return truncate(line, Math.max(1, width), separatorEllipsis);
}

export const EDITOR_STATUS_WIDGET_IDS: ReadonlySet<WidgetId> = new Set(["model", "mode", "fast"]);

export function renderEditorStatus(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	theme: HostTheme,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number = plainVisibleWidth,
): string {
	if (width <= 0) return "";
	const source = segments.filter((segment) => EDITOR_STATUS_WIDGET_IDS.has(segment.id));
	if (source.length === 0) return "";
	const fitted = fitSegmentsToWidth(source, config, theme, width, measure, "");
	return truncate(colorizeSegments(fitted, config, theme, ""), width, "");
}

export function renderStatusLine(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	theme: HostTheme,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number = plainVisibleWidth,
): string | string[] {
	if (config.layout !== "stacked") {
		return renderSingleLine(segments, config, theme, width, truncate, measure);
	}

	const groups = groupSegmentsBySemantics(segments, config);
	const lines: string[] = [];
	for (const group of groups) {
		if (group.length === 0) continue;
		const line = renderSingleLine(group, config, theme, width, truncate, measure);
		if (line.trim().length > 0) lines.push(line);
	}
	return lines.length > 0 ? lines : [renderSingleLine([], config, theme, width, truncate, measure)];
}
