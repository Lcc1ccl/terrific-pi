import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

import type { ContextMode, IconMode, QuotaSnapshot, TokenTotals, ToolActivity } from "./types.ts";

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

export function formatCost(value: number, minimal = false): string {
	const amount = Math.max(0, value).toFixed(2);
	return minimal ? amount : `$${amount}`;
}

export function formatCache(
	tokens: TokenTotals,
	minimal = false,
	iconMode: IconMode = "emoji",
): string | undefined {
	const { input, cacheRead, cacheWrite } = tokens;
	if (cacheRead <= 0 && cacheWrite <= 0) return undefined;

	const prompt = input + cacheRead + cacheWrite;
	const hitRate = prompt > 0 ? ((cacheRead / prompt) * 100).toFixed(1) : "0.0";
	if (minimal) return `${hitRate}%`;
	return iconMode === "plain" ? `cache ${hitRate}%` : `🎯${hitRate}%`;
}

export function formatContextText(
	percent: number | null | undefined,
	mode: ContextMode,
	minimal = false,
): string | undefined {
	if (percent === null || percent === undefined || Number.isNaN(percent)) return undefined;
	const used = Math.max(0, Math.min(100, Math.round(percent)));
	const remaining = Math.max(0, Math.min(100, 100 - used));
	const value = mode === "used" ? used : remaining;
	if (minimal) return `${value}%`;
	return mode === "used" ? `Context ${value}% used` : `Context ${value}% left`;
}

export function formatBar(filledRatio: number, width: number): string {
	const barWidth = Math.max(4, Math.min(40, Math.floor(width || 10)));
	const ratio = Math.max(0, Math.min(1, filledRatio));
	const filled = Math.max(0, Math.min(barWidth, Math.round(ratio * barWidth)));
	const empty = barWidth - filled;
	return `${"█".repeat(filled)}${"░".repeat(empty)}`;
}

export function formatContextBar(
	percent: number | null | undefined,
	width: number,
	mode: ContextMode,
): string | undefined {
	if (percent === null || percent === undefined || Number.isNaN(percent)) return undefined;
	const barWidth = Math.max(4, Math.min(40, Math.floor(width || 10)));
	const used = Math.max(0, Math.min(100, percent));
	const filledRatio = mode === "used" ? used / 100 : (100 - used) / 100;
	const bar = formatBar(filledRatio, barWidth);
	const label = mode === "used"
		? `${Math.round(used)}%`
		: `${Math.max(0, Math.min(100, Math.round(100 - used)))}%`;
	return `[${bar}] ${label}`;
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
): string {
	const compact = formatTokensCompact(value);
	if (iconMode === "plain") {
		return direction === "in" ? `in ${compact}` : `out ${compact}`;
	}
	return direction === "in" ? `${compact}` : `${compact}`;
}

export function formatBranch(branch: string, iconMode: IconMode = "emoji"): string {
	const isDefault = branch === "main" || branch === "master";
	if (isDefault && iconMode === "emoji") return "🏠";
	return branch;
}

export function formatBranchDiff(stats: { additions: number; deletions: number }): string | undefined {
	if (stats.additions === 0 && stats.deletions === 0) return undefined;
	return `+${stats.additions} -${stats.deletions}`;
}

export function formatFastBadge(value: string | undefined, iconMode: IconMode = "emoji"): string | undefined {
	if (!value) return undefined;
	return iconMode === "plain" ? "fast" : value;
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
	const bar = formatBar(clamped / 100, width);
	return `[${bar}] ${Math.round(clamped)}%`;
}

export function formatQuota(
	snapshot: QuotaSnapshot,
	iconMode: IconMode = "emoji",
	barWidth = 6,
): string | undefined {
	const now = Date.now();
	const windows = snapshot.windows.filter((window) => {
		if (!Number.isFinite(window.usedPercent)) return false;
		if (window.resetsAt !== undefined && window.resetsAt <= now) return false;
		return true;
	});
	if (windows.length === 0) return undefined;

	const prefix = iconMode === "plain" ? "usage" : "📊";
	const parts = windows.map((window) => {
		const label = window.label || formatQuotaWindowLabel(window.windowSeconds, window.id);
		return `${label} ${formatQuotaBar(window.usedPercent, barWidth)}`;
	});
	const body = parts.join(" · ");
	const staleMark = snapshot.stale ? " ~" : "";
	return `${prefix} ${body}${staleMark}`;
}

export function formatEnvironment(counts: {
	contextFiles: number;
	skills: number;
	tools: number;
}): string {
	return `${counts.contextFiles} context files · ${counts.skills} skills · ${counts.tools} tools`;
}

export function formatToolActivity(
	activity: Record<string, ToolActivity>,
	iconMode: IconMode = "emoji",
): string | undefined {
	const names = Object.keys(activity).sort((a, b) => a.localeCompare(b));
	if (names.length === 0) return undefined;

	const ok = iconMode === "plain" ? "ok" : "✓";
	const err = iconMode === "plain" ? "error" : "✗";
	const parts: string[] = [];

	for (const name of names) {
		const entry = activity[name]!;
		if (entry.active > 0) {
			parts.push(`… ${name} x${entry.active}`);
		}
		if (entry.error > 0) {
			parts.push(`${err} ${name} x${entry.error}`);
		}
		if (entry.success > 0) {
			parts.push(`${ok} ${name} x${entry.success}`);
		}
	}

	return parts.length > 0 ? parts.join(" · ") : undefined;
}
