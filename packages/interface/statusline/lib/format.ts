import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

import { formatDuration } from "./duration.ts";
import { resolveGlyphs, resolveIconMode, runtimeSymbol } from "./glyphs.ts";
import type { RuntimeInfo } from "./runtime-info.ts";
import type { TurnPerformanceView } from "./telemetry.ts";
import type { WorktreeInfo } from "./worktree.ts";

import {
	DEFAULT_CONTEXT_BAR_WIDTH,
	MAX_CONTEXT_BAR_WIDTH,
	MIN_CONTEXT_BAR_WIDTH,
} from "./config.ts";
import { RUN_METRIC_WIDGET_IDS } from "./types.ts";
import type {
	ContextMode,
	IconMode,
	QuotaSnapshot,
	RunMetricWidgetId,
	SegmentPart,
	SegmentTone,
	TokenTotals,
	ToolActivity,
	ToolActivityMode,
} from "./types.ts";

/** Core agent tools collapsed in compact toolActivity mode. */
export const CORE_TOOL_NAMES = new Set(["bash", "edit", "read", "write"]);
/** Auxiliary package tools collapsed as aux_tools in compact mode. */
export const AUX_TOOL_NAMES = new Set(["web_research", "aux_summarize", "git_finalize"]);

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

/** Dim Ⅰ suffix marks auxiliary usage beside main tokens/cost. */
export const AUX_USAGE_MARKER = "Ⅰ";

/** Append dim Ⅰ suffix; omit auxText for unknown (`Ⅰ ?`). */
export function appendAuxSuffix(parts: SegmentPart[], auxText?: string, uncertain = false): void {
	parts.push({ text: AUX_USAGE_MARKER, tone: "dim" });
	if (auxText) {
		parts.push({ text: ` ${auxText}${uncertain ? "?" : ""}`, tone: "dim" });
	} else {
		parts.push({ text: " ?", tone: "dim" });
	}
}

export function formatCost(
	value: number,
	_minimal = false,
	auxCost = 0,
	auxUnknown = false,
): SegmentContent {
	// Keep `$` always — minimal shortens other labels, not currency identity.
	const amount = Math.max(0, value).toFixed(2);
	const aux = Math.max(0, auxCost);
	const parts: SegmentPart[] = [
		{ text: "$", tone: "label" },
		{ text: amount, tone: "value" },
	];
	if (aux > 0) appendAuxSuffix(parts, `$${aux.toFixed(2)}`, auxUnknown);
	else if (auxUnknown) appendAuxSuffix(parts);
	return content(parts);
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
	// Pi footer uses CH%; keep that short label in minimal mode.
	if (minimal) {
		return content([
			{ text: "CH ", tone: "label" },
			{ text: value, tone: "value" },
		]);
	}
	const resolved = resolveIconMode(iconMode);
	const glyphs = resolveGlyphs(iconMode);
	if (resolved === "plain") {
		return content([
			{ text: "cache ", tone: "label" },
			{ text: value, tone: "value" },
		]);
	}
	return content([
		{ text: `${glyphs.cache} `, tone: "icon" },
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
	if (minimal) {
		const suffix = mode === "used" ? "%" : "% left";
		return content([
			{ text: "ctx ", tone: "label" },
			{ text: `${value}${suffix}`, tone },
		]);
	}
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
	minimal = false,
): SegmentContent | undefined {
	if (percent === null || percent === undefined || Number.isNaN(percent)) return undefined;
	const used = Math.max(0, Math.min(100, percent));
	const filledRatio = mode === "used" ? used / 100 : (100 - used) / 100;
	const label = mode === "used"
		? `${Math.round(used)}%`
		: `${Math.max(0, Math.min(100, Math.round(100 - used)))}%`;
	const parts: SegmentPart[] = [
		{ text: minimal ? "ctx " : "Context ", tone: "label" },
		...formatBarParts(filledRatio, width),
		{ text: label, tone: usageValueTone(used) },
	];
	return content(parts);
}

export function formatCwd(cwd: string): string {
	const home = resolve(homedir());
	const absolute = resolve(cwd);
	const fromHome = relative(home, absolute);
	const insideHome = fromHome === "" || (fromHome !== ".." && !fromHome.startsWith(`..${sep}`));

	if (!insideHome) return absolute;
	return fromHome === "" ? "~" : `~${sep}${fromHome}`;
}

/** Cap session title width so stacked/split HUD project rows stay scannable. */
export const SESSION_NAME_MAX_CHARS = 24;

export function formatSessionName(name: string, maxChars = SESSION_NAME_MAX_CHARS): string {
	const limit = Math.max(1, Math.floor(maxChars));
	const chars = Array.from(name.trim());
	if (chars.length <= limit) return chars.join("");
	if (limit === 1) return "…";
	return `${chars.slice(0, limit - 1).join("")}…`;
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
	auxValue = 0,
): SegmentContent {
	const compact = formatTokensCompact(value);
	const aux = Math.max(0, auxValue);
	const resolved = resolveIconMode(iconMode);
	const glyphs = resolveGlyphs(iconMode);
	const parts: SegmentPart[] = resolved === "plain"
		? [
			{ text: direction === "in" ? "in " : "out ", tone: "label" },
			{ text: compact, tone: "value" },
		]
		: [
			{ text: `${direction === "in" ? glyphs.input : glyphs.output} `, tone: "icon" },
			{ text: compact, tone: "value" },
		];
	if (aux > 0) appendAuxSuffix(parts, formatTokensCompact(aux));
	return content(parts);
}

export type AuxTokenExtras = {
	input?: number;
	output?: number;
	unsplit?: number;
	unknown?: boolean;
};

/** Append neutral unsplit/unknown aux markers after a tokens segment. */
export function appendAuxTokenExtras(parts: SegmentPart[], extras: AuxTokenExtras = {}): void {
	const unsplit = Math.max(0, extras.unsplit ?? 0);
	// Unsplit totals first; always surface unknown even when some in/out is already known.
	if (unsplit > 0) appendAuxSuffix(parts, formatTokensCompact(unsplit), extras.unknown);
	else if (extras.unknown) appendAuxSuffix(parts);
}

/** Compact token pair for minimal mode — keeps in/out (or emoji) labels. */
export function formatTokenPairMinimal(
	input: number,
	output: number,
	iconMode: IconMode = "emoji",
	auxInput = 0,
	auxOutput = 0,
	extras: AuxTokenExtras = {},
): SegmentContent {
	const left = formatTokenDirection("in", input, iconMode, auxInput);
	const right = formatTokenDirection("out", output, iconMode, auxOutput);
	const parts: SegmentPart[] = [
		...left.parts,
		{ text: " · ", tone: "dim" },
		...right.parts,
	];
	appendAuxTokenExtras(parts, {
		input: Math.max(0, auxInput),
		output: Math.max(0, auxOutput),
		unsplit: extras.unsplit,
		unknown: extras.unknown,
	});
	return content(parts);
}

export function formatBranch(branch: string, iconMode: IconMode = "emoji"): SegmentContent {
	const resolved = resolveIconMode(iconMode);
	const glyphs = resolveGlyphs(iconMode);
	const isDefault = branch === "main" || branch === "master";
	if (resolved === "emoji") {
		return content([{ text: isDefault ? glyphs.home : branch, tone: "muted" }]);
	}
	if (resolved === "plain") return content([{ text: branch, tone: "muted" }]);
	if (resolved === "nerd" && isDefault) return content([{ text: glyphs.home, tone: "muted" }]);
	return content([{ text: `${glyphs.git} ${branch}`, tone: "muted" }]);
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
	const resolved = resolveIconMode(iconMode);
	if (resolved === "plain") {
		return content([{ text: "fast", tone: "label" }]);
	}
	const text = resolved === "emoji" ? value : resolveGlyphs(iconMode).fast;
	return content([{ text, tone: "warn" }]);
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

	const resolved = resolveIconMode(iconMode);
	const glyphs = resolveGlyphs(iconMode);
	const parts: SegmentPart[] = [];
	if (resolved === "plain") {
		parts.push({ text: "usage ", tone: "label" });
	} else {
		parts.push({ text: `${glyphs.quota} `, tone: "icon" });
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

function toolBucket(name: string): "core_tools" | "aux_tools" | undefined {
	const key = name.toLowerCase();
	if (CORE_TOOL_NAMES.has(key)) return "core_tools";
	if (AUX_TOOL_NAMES.has(key)) return "aux_tools";
	return undefined;
}

export function formatToolActivity(
	activity: Record<string, ToolActivity>,
	iconMode: IconMode = "emoji",
	mode: ToolActivityMode = "detailed",
): SegmentContent | undefined {
	const names = Object.keys(activity).sort((a, b) => a.localeCompare(b));
	if (names.length === 0) return undefined;

	const resolved = resolveIconMode(iconMode);
	const glyphs = resolveGlyphs(iconMode);
	const ok = resolved === "plain" ? "ok" : glyphs.success;
	const err = resolved === "plain" ? "error" : glyphs.error;
	const parts: SegmentPart[] = [];

	const pushEntry = (
		icon: string,
		tone: "active" | "error" | "success",
		count: number,
		name?: string,
	) => {
		if (count <= 0) return;
		if (parts.length > 0) parts.push({ text: " · ", tone: "dim" });
		parts.push({ text: `${icon} `, tone });
		if (name) parts.push({ text: `${name} `, tone: "label" });
		parts.push({ text: `x${count}`, tone: "value" });
	};

	let totalErrors = 0;
	for (const name of names) totalErrors += activity[name]!.error;
	if (totalErrors > 0) pushEntry(err, "error", totalErrors, "total");

	if (mode === "compact") {
		const buckets = {
			core_tools: { active: 0, success: 0 },
			aux_tools: { active: 0, success: 0 },
		};
		for (const name of names) {
			const bucket = toolBucket(name);
			if (!bucket) continue;
			const entry = activity[name]!;
			buckets[bucket].active += entry.active;
			buckets[bucket].success += entry.success;
		}
		for (const name of ["core_tools", "aux_tools"] as const) {
			const entry = buckets[name];
			if (entry.active > 0) pushEntry("…", "active", entry.active, name);
			if (entry.success > 0) pushEntry(ok, "success", entry.success, name);
		}
		return parts.length > 0 ? content(parts) : undefined;
	}

	for (const name of names) {
		const entry = activity[name]!;
		if (entry.active > 0) pushEntry("…", "active", entry.active, name);
		if (entry.success > 0) pushEntry(ok, "success", entry.success, name);
	}

	return parts.length > 0 ? content(parts) : undefined;
}

export function formatDurationContent(
	pair: string,
	iconMode: IconMode = "emoji",
	minimal = false,
): SegmentContent {
	if (minimal) {
		return content([
			{ text: "t ", tone: "label" },
			{ text: pair, tone: "value" },
		]);
	}
	const resolved = resolveIconMode(iconMode);
	const glyphs = resolveGlyphs(iconMode);
	if (resolved === "emoji") {
		return content([
			{ text: `${glyphs.duration} `, tone: "icon" },
			{ text: pair, tone: "value" },
		]);
	}
	if (resolved !== "plain") {
		return content([
			{ text: `${glyphs.duration} `, tone: "icon" },
			{ text: pair, tone: "value" },
		]);
	}
	return content([
		{ text: "time ", tone: "label" },
		{ text: pair, tone: "value" },
	]);
}

export function formatWorktree(info: WorktreeInfo, iconMode: IconMode): SegmentContent {
	const glyphs = resolveGlyphs(iconMode);
	const parts: SegmentPart[] = [
		{ text: `${glyphs.git} `, tone: "icon" },
		{ text: info.branch ?? info.oid?.slice(0, 7) ?? "?", tone: "muted" },
	];
	const add = (count: number, glyph: string, tone: SegmentTone) => {
		if (count <= 0) return;
		parts.push({ text: " ", tone: "dim" }, { text: `${glyph}${count}`, tone });
	};
	if (info.ahead > 0 && info.behind > 0) {
		parts.push({ text: " ", tone: "dim" }, { text: `${glyphs.diverged}${info.ahead}/${info.behind}`, tone: "warn" });
	} else {
		add(info.ahead, glyphs.ahead, "success");
		add(info.behind, glyphs.behind, "warn");
	}
	add(info.stash, glyphs.stashed, "dim");
	add(info.conflicted, glyphs.conflicted, "error");
	add(info.deleted, glyphs.deleted, "error");
	add(info.modified, glyphs.modified, "warn");
	add(info.renamed, glyphs.renamed, "warn");
	add(info.staged, glyphs.staged, "success");
	add(info.untracked, glyphs.untracked, "muted");
	return content(parts);
}

export function formatRuntime(info: RuntimeInfo, iconMode: IconMode): SegmentContent {
	if (info.ambiguous) return content([{ text: "runtime ", tone: "label" }, { text: "?", tone: "dim" }]);
	const label = runtimeSymbol(info.name, iconMode);
	const resolved = resolveIconMode(iconMode);
	return content([
		{ text: label, tone: resolved === "plain" || resolved === "ascii" ? "label" : "icon" },
		...(info.version ? [{ text: ` ${info.version}`, tone: "muted" as const }] : []),
	]);
}

function formatRunMetricDuration(ms: number): string {
	return ms < 60_000 ? `${(ms / 1_000).toFixed(1)}s` : formatDuration(ms);
}

export function formatRunMetric(
	view: TurnPerformanceView,
	id: RunMetricWidgetId,
	iconMode: IconMode,
): SegmentContent | undefined {
	const glyphs = resolveGlyphs(iconMode);
	const resolved = resolveIconMode(iconMode);
	const label = (glyph: string, name: string) => resolved === "plain" ? name : `${glyph} ${name}`;

	switch (id) {
		case "runTps":
			return content([
				{ text: `${label(glyphs.speed, "TPS")} `, tone: "label" },
				{ text: view.tps === null ? "?" : view.tps.toFixed(1), tone: view.tps === null ? "dim" : "active" },
			]);
		case "runTtft":
			return content([
				{ text: `${label(glyphs.latency, "TTFT")} `, tone: "label" },
				{ text: formatRunMetricDuration(view.ttftMs), tone: "value" },
			]);
		case "runDuration":
			return content([
				{ text: `${label(glyphs.done, "run")} `, tone: "label" },
				{ text: formatRunMetricDuration(view.totalMs), tone: "value" },
			]);
		case "runTokens":
			if (!view.usageAvailable) {
				return content([{ text: "usage ", tone: "label" }, { text: "?", tone: "dim" }]);
			}
			return content([
				{ text: `${label(glyphs.input, "in")} `, tone: "label" },
				{ text: formatTokensCompact(view.inputTokens ?? 0), tone: "value" },
				{ text: " · ", tone: "dim" },
				{ text: `${label(glyphs.output, "out")} `, tone: "label" },
				{ text: formatTokensCompact(view.outputTokens ?? 0), tone: "value" },
			]);
		case "runStalls":
			if (view.stallMs <= 0) return undefined;
			return content([
				{ text: `${label(glyphs.stall, "stall")} `, tone: "warn" },
				{ text: `${view.stallCount}/${formatRunMetricDuration(view.stallMs)}`, tone: "warn" },
			]);
		case "runCostRate":
			if (view.rateUsdPerMTokens === null) return undefined;
			return content([
				{ text: "$", tone: "label" },
				{ text: `${view.rateUsdPerMTokens.toFixed(2)}/M`, tone: "warn" },
			]);
	}
}

export function formatRunNotification(
	view: TurnPerformanceView,
	iconMode: IconMode,
): SegmentContent {
	const items = RUN_METRIC_WIDGET_IDS
		.map((id) => formatRunMetric(view, id, iconMode))
		.filter((item): item is SegmentContent => item !== undefined);
	const parts = items.flatMap((item, index) =>
		index === 0 ? item.parts : [{ text: " · ", tone: "dim" as const }, ...item.parts]
	);
	return content(parts);
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

/**
 * Mode badge tones — quiet risk ladder (no success/warn/accent; those steal focus):
 * ASK dim · PLAN muted · EDIT value · AUTO thinkingLow (soft ambient only).
 */
export function modeTone(mode: string): SegmentTone {
	switch (mode.trim().toUpperCase()) {
		case "ASK": return "dim";
		case "PLAN": return "muted";
		case "EDIT": return "value";
		case "AUTO": return "thinkingLow";
		default: return "muted";
	}
}

export function formatModeContent(mode: string): SegmentContent {
	const text = mode.trim() || mode;
	return content([{ text, tone: modeTone(text) }]);
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
