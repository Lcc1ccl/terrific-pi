import {
	MAX_WIDGET_SPACING,
	MIN_WIDGET_SPACING,
	WIDGET_SEPARATOR_GLYPHS,
} from "./config.ts";
import type {
	Accent,
	SegmentPart,
	SegmentTone,
	StatuslineConfig,
	StatuslineSeparator,
	WidgetLineId,
	WidgetSegment,
} from "./types.ts";
import { WIDGET_LINE_IDS } from "./types.ts";

export type HostThemeColor =
	| "accent"
	| "mdHeading"
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
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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

function segmentsForLine(
	segments: WidgetSegment[],
	config: Pick<StatuslineConfig, "lines">,
	line: WidgetLineId,
): WidgetSegment[] {
	const byId = new Map(segments.map((segment) => [segment.id, segment]));
	return config.lines[line]
		.map((id) => byId.get(id))
		.filter((segment): segment is WidgetSegment => segment !== undefined);
}

export function groupSegmentsByLines(
	segments: WidgetSegment[],
	config: Pick<StatuslineConfig, "lines">,
): WidgetSegment[][] {
	return WIDGET_LINE_IDS.map((line) => segmentsForLine(segments, config, line));
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
		case "model":
			return "accent";
		case "branch":
		case "cost":
			return "mdHeading";
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

function pathParts(path: string): SegmentPart[] {
	const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	if (split >= 0 && split < path.length - 1) {
		return [
			{ text: path.slice(0, split + 1), tone: "active" },
			{ text: path.slice(split + 1), tone: "active" },
		];
	}
	return [{ text: path, tone: "active" }];
}

function leftEllipsize(text: string, width: number, measure: (text: string) => number): string {
	const clean = stripTerminalControls(text);
	if (measure(clean) <= width) return clean;
	const ellipsis = "…";
	if (measure(ellipsis) > width) return "";
	let suffix = "";
	const graphemes = Array.from(
		GRAPHEME_SEGMENTER.segment(clean),
		({ segment }) => segment,
	);
	for (const grapheme of graphemes.reverse()) {
		const candidate = `${ellipsis}${grapheme}${suffix}`;
		if (measure(candidate) > width) break;
		suffix = `${grapheme}${suffix}`;
	}
	return `${ellipsis}${suffix}`;
}

function shrinkPathSegment(
	segment: WidgetSegment,
	width: number,
	measure: (text: string) => number,
): boolean {
	if (segment.id !== "path" || measure(segment.text) <= width) return false;
	const first = segment.parts?.[0];
	const icon = first?.tone === "active" && first.text.endsWith(" ") ? first : undefined;
	const prefix = icon?.text ?? "";
	const body = icon ? segment.text.slice(prefix.length) : segment.text;
	const clipped = leftEllipsize(body, Math.max(0, width - measure(prefix)), measure);
	const text = `${prefix}${clipped}`;
	if (!clipped || text === segment.text) return false;
	segment.text = text;
	segment.parts = [...(icon ? [{ ...icon }] : []), ...pathParts(clipped)];
	return true;
}

/**
 * Shrink paths first, then drop lowest-priority complete segments and shrink bars.
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

	// 1) Preserve the useful tail of elastic paths before dropping whole widgets.
	for (const segment of current) {
		if (segment.id !== "path" || lineWidth() <= maxWidth) continue;
		const overflow = lineWidth() - maxWidth;
		const first = segment.parts?.[0];
		const prefixWidth = first?.tone === "active" && first.text.endsWith(" ") ? measure(first.text) : 0;
		const minimum = prefixWidth + measure("…");
		shrinkPathSegment(segment, Math.max(minimum, measure(segment.text) - overflow), measure);
	}
	if (lineWidth() <= maxWidth) return current;

	// 2) Drop high-priority (low importance) segments one by one.
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

	// 3) Shrink bar segments without changing percentages.
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

function renderSingleLine(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	theme: HostTheme,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number,
	indent = "  ",
): string {
	const fitted = fitSegmentsToWidth(segments, config, theme, width, measure, indent);
	const separatorEllipsis = colorizeText(theme, "dim", "…", "dim");
	const line = colorizeSegments(fitted, config, theme, indent);
	return truncate(line, Math.max(1, width), separatorEllipsis);
}

export function renderEditorStatus(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	theme: HostTheme,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number = plainVisibleWidth,
	line: "line0" | "line1" = "line0",
): string {
	if (width <= 0) return "";
	const source = segmentsForLine(segments, config, line);
	if (source.length === 0) return "";
	return renderSingleLine(source, config, theme, width, truncate, measure, "");
}

export function renderStatusLine(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	theme: HostTheme,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number = plainVisibleWidth,
	startLine: WidgetLineId | boolean = "line1",
): string[] {
	const firstLine = typeof startLine === "boolean" ? (startLine ? "line0" : "line1") : startLine;
	const start = Math.max(0, WIDGET_LINE_IDS.indexOf(firstLine));
	const lines: string[] = [];
	for (const line of WIDGET_LINE_IDS.slice(start)) {
		const source = segmentsForLine(segments, config, line);
		if (source.length === 0) continue;
		const rendered = renderSingleLine(source, config, theme, width, truncate, measure);
		if (rendered.trim().length > 0) lines.push(rendered);
	}
	return lines;
}
