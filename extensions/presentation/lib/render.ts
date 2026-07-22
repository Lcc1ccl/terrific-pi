import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { sanitizeArtifactLabel } from "./artifacts.ts";
import { expandHint } from "./expand-hint.ts";
import { sanitizeSystemText } from "./system-events.ts";
import type {
	ArtifactReceipt,
	FileArtifact,
	PresentationSystemEntry,
	PresentationToolEntry,
	PresentationTone,
} from "./types.ts";

export interface PresentationTheme {
	fg(color: "accent" | "success" | "warning" | "error" | "muted" | "dim", text: string): string;
	bold?(text: string): string;
}

class WidthBoundComponent implements Component {
	private readonly lines: (width: number) => string[];

	constructor(lines: (width: number) => string[]) {
		this.lines = lines;
	}

	render(width: number): string[] {
		return this.lines(width);
	}

	invalidate(): void {}
}

const OPERATION_PREFIX: Record<FileArtifact["operation"], string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	unknown: "?",
};

function fit(lines: string[], width: number): string[] {
	if (width < 1) return [];
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

function diffSuffix(file: FileArtifact): string {
	const additions = file.additions ?? 0;
	const deletions = file.deletions ?? 0;
	if (!additions && !deletions) return "";
	return ` +${additions}${deletions ? `/-${deletions}` : ""}`;
}

function artifactLine(file: FileArtifact, expanded: boolean): string {
	const source = expanded && file.sources.length > 0 ? ` · ${file.sources.join(", ")}` : "";
	const preExisting = expanded && file.preExisting ? " · pre-existing" : "";
	return `${OPERATION_PREFIX[file.operation]} ${sanitizeArtifactLabel(file.path)}${diffSuffix(file)}${source}${preExisting}`;
}

function totalDiff(receipt: ArtifactReceipt): { additions: number; deletions: number } {
	return receipt.files.reduce((total, file) => ({
		additions: total.additions + (file.additions ?? 0),
		deletions: total.deletions + (file.deletions ?? 0),
	}), { additions: 0, deletions: 0 });
}

function totalDiffSuffix(receipt: ArtifactReceipt): string {
	const { additions, deletions } = totalDiff(receipt);
	if (!additions && !deletions) return "";
	return ` · +${additions}${deletions ? `/-${deletions}` : ""}`;
}

function coloredDiff(file: FileArtifact, theme: PresentationTheme): string {
	const additions = file.additions ?? 0;
	const deletions = file.deletions ?? 0;
	if (!additions && !deletions) return "";
	return ` ${additions ? theme.fg("success", `+${additions}`) : ""}${additions && deletions ? theme.fg("muted", "/") : ""}${deletions ? theme.fg("error", `-${deletions}`) : ""}`;
}

function coloredArtifactLine(file: FileArtifact, expanded: boolean, theme: PresentationTheme): string {
	const source = expanded && file.sources.length > 0 ? theme.fg("dim", ` · ${file.sources.join(", ")}`) : "";
	const preExisting = expanded && file.preExisting ? theme.fg("warning", " · pre-existing") : "";
	return `${theme.fg("muted", OPERATION_PREFIX[file.operation])} ${sanitizeArtifactLabel(file.path)}${coloredDiff(file, theme)}${source}${preExisting}`;
}

function coloredTotalDiff(receipt: ArtifactReceipt, theme: PresentationTheme): string {
	const { additions, deletions } = totalDiff(receipt);
	if (!additions && !deletions) return "";
	return ` ${additions ? theme.fg("success", `+${additions}`) : ""}${additions && deletions ? theme.fg("muted", "/") : ""}${deletions ? theme.fg("error", `-${deletions}`) : ""}`;
}

export function formatSystemEntry(entry: PresentationSystemEntry, expanded: boolean): string[] {
	const line = `● ${sanitizeSystemText(entry.label, 48)} · ${sanitizeSystemText(entry.message, 180)}`;
	if (!expanded) return [line];
	return [line, sanitizeSystemText(entry.detail ?? new Date(entry.timestamp).toISOString(), 240)];
}

export function formatArtifactReceipt(
	receipt: ArtifactReceipt,
	expanded: boolean,
	maxExpandedArtifacts: number,
): string[] {
	const maximum = Math.max(1, maxExpandedArtifacts);
	if (!expanded) {
		const shown = receipt.files.slice(0, 2).map((file) => artifactLine(file, false));
		const more = receipt.files.length - shown.length;
		return [`Files ${receipt.files.length} changed${totalDiffSuffix(receipt)}${shown.length ? ` · ${shown.join(" · ")}` : ""}${more > 0 ? ` · +${more} more` : ""}`];
	}
	const lines = [`Files ${receipt.files.length} · ${receipt.gitReconciled ? "git reconciled" : "explicit tools"}`];
	for (const file of receipt.files.slice(0, maximum)) lines.push(artifactLine(file, true));
	const more = receipt.files.length - maximum;
	if (more > 0) lines.push(`+${more} more`);
	return lines;
}

function toneColor(tone: PresentationTone): "accent" | "success" | "warning" | "error" | "muted" {
	if (tone === "success") return "success";
	if (tone === "warning") return "warning";
	if (tone === "error") return "error";
	if (tone === "muted") return "muted";
	return "accent";
}

function bold(theme: PresentationTheme, value: string): string {
	return theme.bold ? theme.bold(value) : value;
}

function renderedSystemLine(entry: PresentationSystemEntry, theme: PresentationTheme): string {
	const tone = toneColor(entry.tone);
	return `${theme.fg(tone, "●")} ${bold(theme, sanitizeSystemText(entry.label, 48))}${theme.fg("muted", " · ")}${sanitizeSystemText(entry.message, 180)}`;
}

export function renderSystemEntry(entry: PresentationSystemEntry, expanded: boolean, theme: PresentationTheme): Component {
	return new WidthBoundComponent((width) => {
		const lines = [renderedSystemLine(entry, theme)];
		if (expanded) lines.push(theme.fg("dim", sanitizeSystemText(entry.detail ?? new Date(entry.timestamp).toISOString(), 240)));
		return fit(lines, width);
	});
}

export function renderArtifactReceipt(receipt: ArtifactReceipt, expanded: boolean, maxExpandedArtifacts: number, theme: PresentationTheme): Component {
	return new WidthBoundComponent((width) => {
		if (!expanded) {
			const shown = receipt.files.slice(0, 2);
			const more = receipt.files.length - shown.length;
			let line = `${theme.fg("muted", "Files ")}${bold(theme, String(receipt.files.length))}${theme.fg("muted", " changed")}${coloredTotalDiff(receipt, theme)}`;
			if (shown.length) line += theme.fg("muted", " · ") + shown.map((file) => coloredArtifactLine(file, false, theme)).join(theme.fg("muted", " · "));
			if (more > 0) line += theme.fg("muted", ` · +${more} more`);
			return fit([line], width);
		}
		const maximum = Math.max(1, maxExpandedArtifacts);
		const lines = [`${theme.fg("muted", "Files ")}${bold(theme, String(receipt.files.length))}${theme.fg("muted", ` · ${receipt.gitReconciled ? "git reconciled" : "explicit tools"}`)}`];
		for (const file of receipt.files.slice(0, maximum)) lines.push(coloredArtifactLine(file, true, theme));
		const more = receipt.files.length - maximum;
		if (more > 0) lines.push(theme.fg("muted", `+${more} more`));
		return fit(lines, width);
	});
}

function toolMarker(entry: PresentationToolEntry): string {
	if (entry.kind === "failure") return "✗";
	if (entry.kind === "skill") return "✓";
	if (entry.kind === "exploration" || entry.kind === "command") return "◆";
	return "●";
}

export function formatToolEntry(entry: PresentationToolEntry, expanded: boolean): string[] {
	const line = `${toolMarker(entry)} ${sanitizeSystemText(entry.label, 80)} · ${sanitizeSystemText(entry.message, 180)}`;
	if (!expanded || !entry.detail) return [line];
	return [line, ...entry.detail.split("\n").map((lineItem) => sanitizeSystemText(lineItem, 240)).filter(Boolean)];
}

function renderedToolMessage(entry: PresentationToolEntry, theme: PresentationTheme): string {
	const parts = sanitizeSystemText(entry.message, 180).split(" · ").filter(Boolean);
	const primary = parts.shift() ?? "";
	const supporting = parts.length > 0 ? `${theme.fg("muted", " · ")}${theme.fg("muted", parts.join(" · "))}` : "";
	return `${primary}${supporting}`;
}

function fitWithTrailingHint(line: string, hint: string, width: number): string {
	if (width < 1) return "";
	const available = width - visibleWidth(hint);
	if (available < 1) return truncateToWidth(hint, width, "…");
	return `${truncateToWidth(line, available, "…")}${hint}`;
}

export function renderToolEntry(entry: PresentationToolEntry, expanded: boolean, theme: PresentationTheme): Component {
	return new WidthBoundComponent((width) => {
		const tone = toneColor(entry.tone);
		const line = `${theme.fg(tone, toolMarker(entry))} ${bold(theme, sanitizeSystemText(entry.label, 80))}${theme.fg("muted", " · ")}${renderedToolMessage(entry, theme)}`;
		const hint = entry.expandable && !expanded ? `${theme.fg("muted", " · ")}${expandHint(theme)}` : "";
		const lines = [hint ? fitWithTrailingHint(line, hint, width) : line];
		if (expanded && entry.detail) {
			for (const detail of entry.detail.split("\n")) {
				const clean = sanitizeSystemText(detail, 240);
				if (clean) lines.push(theme.fg("dim", `  ${clean}`));
			}
		}
		return fit(lines, width);
	});
}
