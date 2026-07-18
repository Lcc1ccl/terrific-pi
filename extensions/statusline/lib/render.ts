import { MAX_WIDGET_SPACING, MIN_WIDGET_SPACING } from "./config.ts";
import type { Accent, SegmentPart, SegmentTone, StatuslineConfig, WidgetGroup, WidgetSegment } from "./types.ts";
import { WIDGET_GROUPS } from "./types.ts";

export type Rgb = readonly [number, number, number];

export interface Palette {
	model: Rgb;
	path: Rgb;
	branch: Rgb;
	state: Rgb;
	usage: Rgb;
	progress: Rgb;
	session: Rgb;
	separator: Rgb;
	/** Near-white default for bars / neutral values. */
	neutral: Rgb;
	/** Muted label / secondary text. */
	label: Rgb;
	dim: Rgb;
	error: Rgb;
	warn: Rgb;
	success: Rgb;
	/** Default bar fill (white). */
	bar: Rgb;
}

// Adaptive dark/light palettes for pi footer segments.
// Segment colors are softened to 85% saturation later.
export const DARK_PALETTE: Palette = {
	model: [137, 180, 250],
	path: [166, 227, 161],
	branch: [250, 179, 135],
	state: [203, 166, 247],
	usage: [249, 226, 175],
	progress: [166, 227, 161],
	session: [148, 226, 213],
	separator: [118, 129, 140],
	neutral: [205, 214, 244],
	label: [108, 112, 134],
	dim: [88, 91, 112],
	error: [243, 139, 168],
	warn: [249, 226, 175],
	success: [166, 227, 161],
	bar: [205, 214, 244],
};

export const LIGHT_PALETTE: Palette = {
	model: [30, 102, 245],
	path: [64, 160, 43],
	branch: [254, 100, 11],
	state: [136, 57, 239],
	usage: [223, 142, 29],
	progress: [64, 160, 43],
	session: [23, 146, 153],
	separator: [108, 112, 134],
	neutral: [76, 79, 105],
	label: [124, 127, 147],
	dim: [140, 143, 161],
	error: [210, 15, 57],
	warn: [223, 142, 29],
	success: [64, 160, 43],
	bar: [76, 79, 105],
};

export function softenColor([red, green, blue]: Rgb): Rgb {
	const luma = Math.floor((77 * red + 150 * green + 29 * blue) / 256);
	const soften = (channel: number) => Math.floor((channel * 85 + luma * 15 + 50) / 100);
	return [soften(red), soften(green), soften(blue)];
}

export function foreground([red, green, blue]: Rgb, text: string): string {
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

function accentBase(palette: Palette, accent: Accent): Rgb {
	if (accent === "dim") return palette.dim;
	if (accent === "session") return palette.session;
	if (accent === "neutral") return palette.neutral;
	return palette[accent];
}

export function toneColor(palette: Palette, accent: Accent, tone: SegmentTone = "value"): Rgb {
	switch (tone) {
		case "value":
			return accent === "dim" ? palette.dim : accentBase(palette, accent);
		case "label":
		case "icon":
			return palette.label;
		case "dim":
			return palette.dim;
		case "error":
			return palette.error;
		case "warn":
			return palette.warn;
		case "bar":
			return palette.bar;
		case "success":
			return palette.success;
	}
}

export function styled(palette: Palette, accent: Accent, text: string, tone: SegmentTone = "value"): string {
	return foreground(softenColor(toneColor(palette, accent, tone)), text);
}

export function styledParts(palette: Palette, accent: Accent, parts: SegmentPart[]): string {
	return parts.map((part) => styled(palette, accent, part.text, part.tone ?? "value")).join("");
}

export function selectPalette(themeName: string | undefined): Palette {
	return themeName?.toLowerCase().includes("light") ? LIGHT_PALETTE : DARK_PALETTE;
}

export function formatWidgetSeparator(spacing: number): string {
	const width = Math.max(MIN_WIDGET_SPACING, Math.min(MAX_WIDGET_SPACING, Math.floor(spacing)));
	const gap = " ".repeat(width);
	return `${gap}·${gap}`;
}

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Fallback visible width when pi-tui helper is not injected. */
export function plainVisibleWidth(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function segmentGroup(segment: WidgetSegment): WidgetGroup {
	return WIDGET_GROUPS[segment.id] ?? "activity";
}

function colorizeSegment(palette: Palette, segment: WidgetSegment): string {
	if (segment.parts && segment.parts.length > 0) {
		return styledParts(palette, segment.accent, segment.parts);
	}
	return styled(palette, segment.accent, segment.text);
}

function colorizeSegments(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	palette: Palette,
): string {
	const separator = foreground(palette.separator, formatWidgetSeparator(config.spacing));
	const colored = segments.map((segment) => colorizeSegment(palette, segment));
	return `  ${colored.join(separator)}`;
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
	palette: Palette,
	width: number,
	measure: (text: string) => number,
): WidgetSegment[] {
	const maxWidth = Math.max(1, width);
	let current = cloneSegments(segments);

	const lineWidth = () => measure(colorizeSegments(current, config, palette));
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
		if (dropIndex < 0 || dropPriority <= 5) break;
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

export function groupSegmentsBySemantics(segments: WidgetSegment[]): WidgetSegment[][] {
	const lines: WidgetSegment[][] = [];
	let current: WidgetSegment[] = [];
	let currentGroup: WidgetGroup | undefined;

	for (const segment of segments) {
		const group = segmentGroup(segment);
		if (currentGroup === undefined) {
			currentGroup = group;
			current = [segment];
			continue;
		}
		if (group !== currentGroup) {
			if (current.length > 0) lines.push(current);
			current = [segment];
			currentGroup = group;
			continue;
		}
		current.push(segment);
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

function renderSingleLine(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	palette: Palette,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number,
): string {
	const fitted = fitSegmentsToWidth(segments, config, palette, width, measure);
	const separatorEllipsis = foreground(palette.separator, "…");
	const line = colorizeSegments(fitted, config, palette);
	return truncate(line, Math.max(1, width), separatorEllipsis);
}

export function renderStatusLine(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	palette: Palette,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
	measure: (text: string) => number = plainVisibleWidth,
): string | string[] {
	if (config.layout !== "stacked") {
		return renderSingleLine(segments, config, palette, width, truncate, measure);
	}

	const groups = groupSegmentsBySemantics(segments);
	const lines: string[] = [];
	for (const group of groups) {
		if (group.length === 0) continue;
		const line = renderSingleLine(group, config, palette, width, truncate, measure);
		if (line.trim().length > 0) lines.push(line);
	}
	return lines.length > 0 ? lines : [renderSingleLine([], config, palette, width, truncate, measure)];
}
