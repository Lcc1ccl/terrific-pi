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
): WidgetSegment[] {
	const maxWidth = Math.max(1, width);
	let current = cloneSegments(segments);

	const lineWidth = () => measure(colorizeSegments(current, config, theme));
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

const TERRIFIC_LINE_1: readonly [readonly WidgetSegment["id"][], readonly WidgetSegment["id"][]] = [
	["path", "branch"],
	["model", "mode", "fast"],
];
const TERRIFIC_LINE_2_LEFT: readonly WidgetSegment["id"][] = ["state", "duration", "progress"];
const TERRIFIC_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;

export function withTerrificStateSpinner(
	segments: WidgetSegment[],
	runState: "Ready" | "Working" | "Thinking" | "Waiting",
	frame: number,
	dumbTerminal: boolean,
): WidgetSegment[] {
	if (runState === "Ready") return segments;
	const spinner = dumbTerminal
		? "*"
		: TERRIFIC_SPINNER_FRAMES[Math.abs(Math.floor(frame)) % TERRIFIC_SPINNER_FRAMES.length]!;
	return segments.map((segment) => segment.id !== "state" ? segment : {
		...segment,
		text: `${spinner} ${segment.text}`,
		parts: [{ text: `${spinner} `, tone: "active" }, ...(segment.parts ?? [{ text: segment.text }])],
	});
}

function orderedSegments(segments: WidgetSegment[], ids: readonly WidgetSegment["id"][]): WidgetSegment[] {
	return ids.flatMap((id) => segments.filter((segment) => segment.id === id));
}

function renderTerrificZoneLine(
	segments: WidgetSegment[],
	leftIds: readonly WidgetSegment["id"][],
	rightIds: readonly WidgetSegment["id"][],
	config: StatuslineConfig,
	theme: HostTheme,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number,
): string {
	const leftSource = orderedSegments(segments, leftIds);
	const rightSource = orderedSegments(segments, rightIds);
	const fitted = fitSegmentsToWidth([...leftSource, ...rightSource], config, theme, width, measure);
	const included = new Set(fitted.map((segment) => segment.id));
	const left = fitted.filter((segment) => included.has(segment.id) && leftIds.includes(segment.id));
	const right = fitted.filter((segment) => included.has(segment.id) && rightIds.includes(segment.id));
	const leftText = colorizeSegments(left, config, theme, left.length > 0 ? "  " : "");
	const rightText = colorizeSegments(right, config, theme, "");
	const leftWidth = measure(leftText);
	const rightWidth = measure(rightText);
	const gap = right.length > 0 ? " ".repeat(Math.max(1, width - leftWidth - rightWidth)) : "";
	const aligned = left.length > 0 ? `${leftText}${gap}${rightText}` : `${" ".repeat(Math.max(0, width - rightWidth))}${rightText}`;
	return truncate(aligned, Math.max(1, width), colorizeText(theme, "dim", "…", "dim"));
}

function renderTerrific(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	theme: HostTheme,
	width: number,
	terminalRows: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number,
): string | string[] {
	if (width < 80 || terminalRows < 20) {
		const state = orderedSegments(segments, ["state"]);
		const model = orderedSegments(segments, ["model"]);
		const context = orderedSegments(segments, ["context"]);
		const contextFallback = context.length > 0 ? context : orderedSegments(segments, ["contextBar"]);
		return renderSingleLine([...state, ...model, ...contextFallback], config, theme, width, truncate, measure);
	}
	const [line1Left, line1Right] = TERRIFIC_LINE_1;
	const contextId: WidgetSegment["id"] = segments.some((segment) => segment.id === "context")
		? "context"
		: "contextBar";
	return [
		renderTerrificZoneLine(segments, line1Left, line1Right, config, theme, width, truncate, measure),
		renderTerrificZoneLine(
			segments,
			TERRIFIC_LINE_2_LEFT,
			["tokens", contextId, "cost", "quota"],
			config,
			theme,
			width,
			truncate,
			measure,
		),
	];
}

export function renderStatusLine(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	theme: HostTheme,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number = plainVisibleWidth,
	terminalRows = 24,
): string | string[] {
	if (config.layout === "terrific") {
		return renderTerrific(segments, config, theme, width, terminalRows, truncate, measure);
	}
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
