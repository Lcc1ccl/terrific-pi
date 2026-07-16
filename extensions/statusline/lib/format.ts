import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

import type { ContextMode, TokenTotals } from "./types.ts";

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

export function formatCache(tokens: TokenTotals, minimal = false): string | undefined {
	const { input, cacheRead, cacheWrite } = tokens;
	if (cacheRead <= 0 && cacheWrite <= 0) return undefined;

	const prompt = input + cacheRead + cacheWrite;
	const hitRate = prompt > 0 ? ((cacheRead / prompt) * 100).toFixed(1) : "0.0";
	const read = formatTokensCompact(cacheRead);
	const write = formatTokensCompact(cacheWrite);
	return minimal ? `R${read} W${write} ${hitRate}%` : `R${read} W${write} CH${hitRate}%`;
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

export function formatContextBar(
	percent: number | null | undefined,
	width: number,
	mode: ContextMode,
	minimal = false,
): string | undefined {
	if (percent === null || percent === undefined || Number.isNaN(percent)) return undefined;
	const barWidth = Math.max(4, Math.min(40, Math.floor(width || 10)));
	const used = Math.max(0, Math.min(100, percent));
	const filledRatio = mode === "used" ? used / 100 : (100 - used) / 100;
	const filled = Math.max(0, Math.min(barWidth, Math.round(filledRatio * barWidth)));
	const empty = barWidth - filled;
	const bar = `${"█".repeat(filled)}${"░".repeat(empty)}`;
	const label = mode === "used"
		? `${Math.round(used)}%`
		: `${Math.max(0, Math.min(100, Math.round(100 - used)))}%`;
	return minimal ? `[${bar}] ${label}` : `ctx [${bar}] ${label}`;
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

export function formatBranchDiff(stats: { additions: number; deletions: number }): string {
	if (stats.additions === 0 && stats.deletions === 0) return "No changes";
	return `+${stats.additions} -${stats.deletions}`;
}
