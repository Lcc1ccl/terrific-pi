import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface CompatibilityTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	getBgAnsi?(color: string): string;
	bold?(text: string): string;
}

const MIN_WIDTH = 8;
const TITLE = " user ";
const PROMPT_ZONE_PATTERN = /\x1b\](?:133|633);[A-Z](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const BACKGROUND_RESET = "\x1b[49m";
const STYLE_RESETS = [39, 22, 23, 24, 25, 27, 28, 29, 59] as const;

function parseSgr(value: string): number[] {
	if (!value.trim()) return [0];
	return value.split(";").map((item) => Number.parseInt(item, 10)).filter(Number.isFinite);
}

function stripBackgroundCodes(text: string): string {
	return text.replace(SGR_PATTERN, (_sequence, raw: string) => {
		const params = parseSgr(raw);
		const kept: number[] = [];
		for (let index = 0; index < params.length; index += 1) {
			const param = params[index] ?? 0;
			if (param === 0) {
				kept.push(...STYLE_RESETS);
				continue;
			}
			if (param === 49 || (param >= 40 && param <= 47) || (param >= 100 && param <= 107)) continue;
			if (param === 38 || param === 48) {
				const mode = params[index + 1];
				const length = mode === 5 ? 3 : mode === 2 ? 5 : 1;
				const sequence = params.slice(index, index + length);
				if (param === 38 && sequence.length === length) kept.push(...sequence);
				index += length - 1;
				continue;
			}
			kept.push(param);
		}
		return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
	});
}

function splitPromptZones(lines: string[]): { lines: string[]; start: string; end: string } {
	const starts: string[] = [];
	const ends: string[] = [];
	const clean = lines.map((line) => line.replace(PROMPT_ZONE_PATTERN, (marker) => {
		if (/;(?:A)(?:;|\x07|\x1b\\)/.test(marker)) starts.push(marker);
		else ends.push(marker);
		return "";
	}));
	return { lines: clean, start: starts.join(""), end: ends.join("") };
}

function border(theme: CompatibilityTheme | undefined, value: string): string {
	if (!theme) return value;
	try {
		return theme.fg("border", value);
	} catch {
		return value;
	}
}

function title(theme: CompatibilityTheme | undefined, value: string): string {
	if (!theme) return value;
	try {
		const strong = theme.bold ? theme.bold(value) : value;
		return theme.fg("accent", strong);
	} catch {
		return value;
	}
}

function background(theme: CompatibilityTheme | undefined, value: string): string {
	const clean = stripBackgroundCodes(value);
	if (!theme) return clean;
	try {
		if (theme.getBgAnsi) return `${theme.getBgAnsi("userMessageBg")}${clean}${BACKGROUND_RESET}`;
	} catch {}
	try {
		if (theme.bg) return theme.bg("userMessageBg", clean);
	} catch {}
	return clean;
}

function top(width: number, theme: CompatibilityTheme | undefined): string {
	const inner = width - 2;
	const label = truncateToWidth(TITLE, inner, "");
	const fill = "─".repeat(Math.max(0, inner - visibleWidth(label)));
	return background(theme, `${border(theme, "╭")}${title(theme, label)}${border(theme, `${fill}╮`)}`);
}

function bottom(width: number, theme: CompatibilityTheme | undefined): string {
	return background(theme, border(theme, `╰${"─".repeat(Math.max(0, width - 2))}╯`));
}

function body(line: string, width: number, theme: CompatibilityTheme | undefined): string {
	const contentWidth = Math.max(1, width - 4);
	const content = truncateToWidth(stripBackgroundCodes(line), contentWidth, "", true);
	const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
	return background(theme, `${border(theme, "│")} ${content}${padding} ${border(theme, "│")}`);
}

export function renderUserMessageBox(
	instance: unknown,
	width: number,
	original: (this: unknown, width: number) => string[],
	theme: CompatibilityTheme | undefined,
	enabled: boolean,
): string[] {
	const safeWidth = Math.max(0, Math.floor(width));
	if (!enabled || safeWidth < MIN_WIDTH) return original.call(instance, safeWidth);
	try {
		const originalLines = original.call(instance, Math.max(1, safeWidth - 4));
		if (!Array.isArray(originalLines) || originalLines.length === 0) return original.call(instance, safeWidth);
		const zones = splitPromptZones(originalLines);
		return [
			"",
			`${zones.start}${top(safeWidth, theme)}`,
			...zones.lines.map((line) => body(line, safeWidth, theme)),
			`${zones.end}${bottom(safeWidth, theme)}`,
		];
	} catch {
		return original.call(instance, safeWidth);
	}
}
