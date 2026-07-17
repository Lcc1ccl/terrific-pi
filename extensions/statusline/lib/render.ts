import { MAX_WIDGET_SPACING, MIN_WIDGET_SPACING } from "./config.ts";
import type { Accent, StatuslineConfig, WidgetSegment } from "./types.ts";

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
};

export function softenColor([red, green, blue]: Rgb): Rgb {
	const luma = Math.floor((77 * red + 150 * green + 29 * blue) / 256);
	const soften = (channel: number) => Math.floor((channel * 85 + luma * 15 + 50) / 100);
	return [soften(red), soften(green), soften(blue)];
}

export function foreground([red, green, blue]: Rgb, text: string): string {
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

export function styled(palette: Palette, accent: Accent, text: string): string {
	const color = accent === "session" ? palette.session : palette[accent];
	return foreground(softenColor(color), text);
}

export function selectPalette(themeName: string | undefined): Palette {
	return themeName?.toLowerCase().includes("light") ? LIGHT_PALETTE : DARK_PALETTE;
}

export function formatWidgetSeparator(spacing: number): string {
	const width = Math.max(MIN_WIDGET_SPACING, Math.min(MAX_WIDGET_SPACING, Math.floor(spacing)));
	const gap = " ".repeat(width);
	return `${gap}·${gap}`;
}

export function renderStatusLine(
	segments: WidgetSegment[],
	config: StatuslineConfig,
	palette: Palette,
	width: number,
	truncate: (text: string, maxWidth: number, ellipsis: string) => string,
): string {
	const separator = foreground(palette.separator, formatWidgetSeparator(config.spacing));
	const ellipsis = foreground(palette.separator, "…");
	const colored = segments.map((segment) => styled(palette, segment.accent, segment.text));
	const line = `  ${colored.join(separator)}`;
	return truncate(line, Math.max(1, width), ellipsis);
}
