import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

import {
	DEFAULT_CONTEXT_BAR_WIDTH,
	MAX_CONTEXT_BAR_WIDTH,
	MIN_CONTEXT_BAR_WIDTH,
} from "./config.ts";
import type {
	ContextMode,
	IconMode,
	QuotaSnapshot,
	SegmentPart,
	SegmentTone,
	TokenTotals,
	ToolActivity,
} from "./types.ts";

export type SegmentContent = {
	text: string;
	parts: SegmentPart[];
};

/** Match pi's native footer thresholds; severity always follows used percent. */
export const USAGE_WARN_USED_PERCENT = 70;
export const USAGE_ERROR_USED_PERCENT = 90;

function content(parts: SegmentPart[]): SegmentContent {
	return {
		text: parts.map((part) => part.text).join(""),
		parts,
	};
}

export function usageValueTone(usedPercent: number): SegmentTone {
	const used = Math.max(0, Math.min(100, usedPercent));
	if (used > USAGE_ERROR_USED_PERCENT) return "error";
	if (used > USAGE_WARN_USED_PERCENT) return "warn";
	return "value";
}

export function formatBarParts(filledRatio: number, width: number): SegmentPart[] {
	const barWidth = Math.max(
		MIN_CONTEXT_BAR_WIDTH,
		Math.min(MAX_CONTEXT_BAR_WIDTH, Math.floor(width || DEFAULT_CONTEXT_BAR_WIDTH)),
	);
	const ratio = Math.max(0, Math.min(1, filledRatio));
	const filled = Math.max(0, Math.min(barWidth, Math.round(ratio * barWidth)));
	const empty = barWidth - filled;
	return [
		{ text: "[", tone: "dim" },
		{ text: "█".repeat(filled), tone: "bar" },
		{ text: "░".repeat(empty), tone: "dim" },
		{ text: "] ", tone: "dim" },
	];
}

export function formatTokensCompact(value: number): string {
	const count = Math.max(0, value);
	if (count === 0) return "0";
	if (count < 1_000) return String(count);

	let scaled: number;
	let suffix: string;
	if (count >= 1_000_000_000_000) {
		scaled = count / 1_000_000_000_000;
		suffix = "T";
	} else if (count >= 1_000_000_000) {
		scaled = count / 1_000_000_000;
		suffix = "B";
	} else if (count >= 1_000_000) {
		scaled = count / 1_000_000;
		suffix = "M";
	} else {
		scaled = count / 1_000;
		suffix = "K";
	}

	const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
	return `${scaled.toFixed(decimals).replace(/\.0+$|(?<=\.[0-9]*)0+$/g, "")}${suffix}`;
}

export function formatCost(value: number, minimal = false): SegmentContent {
	const amount = Math.max(0, value).toFixed(2);
	if (minimal) return content([{ text: amount, tone: "value" }]);
	return content([
		{ text: "$", tone: "label" },
		{ text: amount, tone: "value" },
	]);
}

export function formatCache(
	tokens: TokenTotals,
	minimal = false,
	iconMode: IconMode = "emoji",
): SegmentContent | undefined {
	const { input, cacheRead, cacheWrite } = tokens;
	if (cacheRead <= 0 && cacheWrite <= 0) return undefined;

	const prompt = input + cacheRead + cacheWrite;
	const hitRate = prompt > 0 ? ((cacheRead / prompt) * 100).toFixed(1) : "0.0";
	const value = `${hitRate}%`;
	if (minimal) return content([{ text: value, tone: "value" }]);
	if (iconMode === "plain") {
		return content([
			{ text: "cache ", tone: "label" },
			{ text: value, tone: "value" },
		]);
	}
	return content([
		{ text: "🎯 ", tone: "icon" },
		{ text: value, tone: "value" },
	]);
}

export function formatContextText(
	percent: number | null | undefined,
	mode: ContextMode,
	minimal = false,
): SegmentContent | undefined {
	if (percent === null || percent === undefined || Number.isNaN(percent)) return undefined;
	const usedPercent = Math.max(0, Math.min(100, percent));
	const used = Math.round(usedPercent);
	const remaining = Math.max(0, Math.min(100, 100 - used));
	const value = mode === "used" ? used : remaining;
	const tone = usageValueTone(usedPercent);
	if (minimal) return content([{ text: `${value}%`, tone }]);
	const suffix = mode === "used" ? "% used" : "% left";
	return content([
		{ text: "Context ", tone: "label" },
		{ text: `${value}${suffix}`, tone },
	]);
}

export function formatBar(filledRatio: number, width: number): string {
	const parts = formatBarParts(filledRatio, width);
	// Keep a plain bar body without brackets for callers that only need glyphs.
	return `${parts[1]?.text ?? ""}${parts[2]?.text ?? ""}`;
}

export function formatContextBar(
	percent: number | null | undefined,
	width: number,
	mode: ContextMode,
): SegmentContent | undefined {
	if (percent === null || percent === undefined || Number.isNaN(percent)) return undefined;
	const used = Math.max(0, Math.min(100, percent));
	const filledRatio = mode === "used" ? used / 100 : (100 - used) / 100;
	const label = mode === "used"
		? `${Math.round(used)}%`
		: `${Math.max(0, Math.min(100, Math.round(100 - used)))}%`;
	return content([
		{ text: "Context ", tone: "label" },
		...formatBarParts(filledRatio, width),
		{ text: label, tone: usageValueTone(used) },
	]);
}

export function formatCwd(cwd: string): string {
	const home = resolve(homedir());
	const absolute = resolve(cwd);
	const fromHome = relative(home, absolute);
	const insideHome = fromHome === "" || (fromHome !== ".." && !fromHome.startsWith(`..${sep}`));

	if (!insideHome) return absolute;
	return fromHome === "" ? "~" : `~${sep}${fromHome}`;
}

export function formatTokensPair(input: number, output: number, minimal = false): string {
	const left = formatTokensCompact(input);
	const right = formatTokensCompact(output);
	return minimal ? `${left}/${right}` : `${left} in · ${right} out`;
}

export function formatTokenDirection(
	direction: "in" | "out",
	value: number,
	iconMode: IconMode = "emoji",
): SegmentContent {
	const compact = formatTokensCompact(value);
	if (iconMode === "plain") {
		return content([
			{ text: direction === "in" ? "in " : "out ", tone: "label" },
			{ text: compact, tone: "value" },
		]);
	}
	return content([
		{ text: direction === "in" ? "🔼 " : "🔽 ", tone: "icon" },
		{ text: compact, tone: "value" },
	]);
}

export function formatTokenPairMinimal(
	input: number,
	output: number,
	iconMode: IconMode = "emoji",
): SegmentContent {
	const left = formatTokensCompact(input);
	const right = formatTokensCompact(output);
	if (iconMode === "plain") {
		return content([
			{ text: "in ", tone: "label" },
			{ text: left, tone: "value" },
			{ text: "/", tone: "label" },
			{ text: "out ", tone: "label" },
			{ text: right, tone: "value" },
		]);
	}
	return content([
		{ text: "🔼 ", tone: "icon" },
		{ text: left, tone: "value" },
		{ text: "/", tone: "label" },
		{ text: "🔽 ", tone: "icon" },
		{ text: right, tone: "value" },
	]);
}

export function formatBranch(branch: string, iconMode: IconMode = "emoji"): SegmentContent {
	const isDefault = branch === "main" || branch === "master";
	if (isDefault && iconMode === "emoji") {
		return content([{ text: "🏠", tone: "muted" }]);
	}
	return content([{ text: branch, tone: "muted" }]);
}

export function formatBranchDiff(stats: { additions: number; deletions: number }): SegmentContent | undefined {
	if (stats.additions === 0 && stats.deletions === 0) return undefined;
	return content([
		{ text: "+", tone: "success" },
		{ text: String(stats.additions), tone: "value" },
		{ text: " ", tone: "dim" },
		{ text: "-", tone: "error" },
		{ text: String(stats.deletions), tone: "value" },
	]);
}

export function formatFastBadge(value: string | undefined, iconMode: IconMode = "emoji"): SegmentContent | undefined {
	if (!value) return undefined;
	if (iconMode === "plain") {
		return content([{ text: "fast", tone: "label" }]);
	}
	// Warning maps to the active theme's gold/yellow emphasis.
	return content([{ text: value, tone: "warn" }]);
}

export function formatQuotaWindowLabel(windowSeconds: number | undefined, fallback: string): string {
	if (!windowSeconds || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return fallback;
	const hours = windowSeconds / 3600;
	if (Math.abs(hours - 5) < 0.05) return "5h";
	if (Math.abs(hours - 24) < 0.05) return "24h";
	if (Math.abs(hours - 168) < 0.5 || Math.abs(hours - 7 * 24) < 0.5) return "7d";
	if (hours >= 24) {
		const days = hours / 24;
		return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
	}
	if (Number.isInteger(hours)) return `${hours}h`;
	return `${hours.toFixed(1)}h`;
}

export function formatQuotaBar(usedPercent: number, width: number): string {
	const clamped = Math.max(0, Math.min(100, usedPercent));
	const parts = formatBarParts(clamped / 100, width);
	return `${parts.map((part) => part.text).join("")}${Math.round(clamped)}%`;
}

export function formatQuotaBarParts(usedPercent: number, width: number): SegmentPart[] {
	const clamped = Math.max(0, Math.min(100, usedPercent));
	return [
		...formatBarParts(clamped / 100, width),
		{ text: `${Math.round(clamped)}%`, tone: usageValueTone(clamped) },
	];
}

export function formatQuota(
	snapshot: QuotaSnapshot,
	iconMode: IconMode = "emoji",
	barWidth = 6,
): SegmentContent | undefined {
	const now = Date.now();
	const windows = snapshot.windows.filter((window) => {
		if (!Number.isFinite(window.usedPercent)) return false;
		if (window.resetsAt !== undefined && window.resetsAt <= now) return false;
		return true;
	});
	if (windows.length === 0) return undefined;

	const parts: SegmentPart[] = [];
	if (iconMode === "plain") {
		parts.push({ text: "usage ", tone: "label" });
	} else {
		parts.push({ text: "📊 ", tone: "icon" });
	}

	windows.forEach((window, index) => {
		if (index > 0) parts.push({ text: " · ", tone: "dim" });
		const label = window.label || formatQuotaWindowLabel(window.windowSeconds, window.id);
		parts.push({ text: `${label} `, tone: "label" });
		parts.push(...formatQuotaBarParts(window.usedPercent, barWidth));
	});
	if (snapshot.stale) parts.push({ text: " ~", tone: "dim" });
	return content(parts);
}

export function formatEnvironment(counts: {
	contextFiles: number;
	skills: number;
	tools: number;
}): SegmentContent {
	return content([
		{ text: String(counts.contextFiles), tone: "dim" },
		{ text: " context files", tone: "dim" },
		{ text: " · ", tone: "dim" },
		{ text: String(counts.skills), tone: "dim" },
		{ text: " skills", tone: "dim" },
		{ text: " · ", tone: "dim" },
		{ text: String(counts.tools), tone: "dim" },
		{ text: " tools", tone: "dim" },
	]);
}

export function formatToolActivity(
	activity: Record<string, ToolActivity>,
	iconMode: IconMode = "emoji",
): SegmentContent | undefined {
	const names = Object.keys(activity).sort((a, b) => a.localeCompare(b));
	if (names.length === 0) return undefined;

	const ok = iconMode === "plain" ? "ok" : "✓";
	const err = iconMode === "plain" ? "error" : "✗";
	const parts: SegmentPart[] = [];
	let totalErrors = 0;

	const pushEntry = (
		icon: string,
		tone: "active" | "error" | "success",
		count: number,
		name?: string,
	) => {
		if (parts.length > 0) parts.push({ text: " · ", tone: "dim" });
		parts.push({ text: `${icon} `, tone });
		if (name) parts.push({ text: `${name} `, tone: "label" });
		parts.push({ text: `x${count}`, tone: "value" });
	};

	for (const name of names) {
		const entry = activity[name]!;
		totalErrors += entry.error;
		if (entry.active > 0) pushEntry("…", "active", entry.active, name);
		if (entry.success > 0) pushEntry(ok, "success", entry.success, name);
	}
	if (totalErrors > 0) pushEntry(err, "error", totalErrors);

	return parts.length > 0 ? content(parts) : undefined;
}

export function formatDurationContent(
	pair: string,
	iconMode: IconMode = "emoji",
): SegmentContent {
	if (iconMode === "emoji") {
		return content([
			{ text: "🕒 ", tone: "icon" },
			{ text: pair, tone: "value" },
		]);
	}
	return content([
		{ text: "time ", tone: "label" },
		{ text: pair, tone: "value" },
	]);
}

export function thinkingLevelTone(level: string): SegmentTone {
	switch (level) {
		case "minimal": return "thinkingMinimal";
		case "low": return "thinkingLow";
		case "medium": return "thinkingMedium";
		case "high": return "thinkingHigh";
		case "xhigh": return "thinkingXhigh";
		case "max": return "thinkingMax";
		default: return "thinkingOff";
	}
}

export function formatModelContent(
	modelId: string,
	thinkingLevel: string,
	hasReasoning: boolean,
): SegmentContent {
	if (hasReasoning) {
		return content([
			{ text: modelId, tone: "value" },
			{ text: ` ${thinkingLevel}`, tone: thinkingLevelTone(thinkingLevel) },
		]);
	}
	return content([{ text: modelId, tone: "value" }]);
}
