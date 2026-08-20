/**
 * /context — context occupancy inspector (no model calls; optional explicit compaction).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildSessionContext,
	CONFIG_DIR_NAME,
	copyToClipboard,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, resolveConfigPaths, updateContextConfig } from "../lib/config.ts";
import { TextOverlay, type OverlayAction } from "../lib/overlay.ts";
import { selectMenu } from "../lib/select-menu.ts";
import { report } from "../lib/output.ts";
import { redactPreview } from "../lib/redact.ts";
import {
	analyzeContext,
	CATEGORY_LABELS,
	formatToken,
	safeContextUsage,
	topEntries,
	type CategoryKey,
	type ClassifiableMessage,
	type ContextBreakdown,
	type SafeContextUsage,
	type EntryEstimate,
} from "../lib/tokens.ts";

const ORDER: CategoryKey[] = [
	"system",
	"user",
	"assistantText",
	"thinking",
	"toolCalls",
	"toolResults",
	"compaction",
	"branchSummary",
	"custom",
	"images",
	"unclassified",
];

type InspectorBreakdown = ContextBreakdown & { safeUsage?: SafeContextUsage };

function buildBreakdown(ctx: ExtensionCommandContext): InspectorBreakdown {
	const usage = ctx.getContextUsage();
	const systemPrompt = ctx.getSystemPrompt?.() ?? "";
	const sessionCtx = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const messages = (sessionCtx.messages ?? []) as ClassifiableMessage[];

	const breakdown = analyzeContext({
		systemPrompt,
		messages,
		totalTokens: usage?.tokens ?? null,
		contextWindow: usage?.contextWindow ?? null,
		percent: usage?.percent ?? null,
	});
	const safeUsage = safeContextUsage(
		usage?.tokens ?? null,
		usage?.contextWindow ?? null,
		typeof ctx.model?.maxTokens === "number" ? ctx.model.maxTokens : undefined,
	);
	return { ...breakdown, ...(safeUsage ? { safeUsage } : {}) };
}

function summaryLines(breakdown: InspectorBreakdown, topN: number): string[] {
	const lines: string[] = [];
	const total =
		breakdown.totalTokens != null ? breakdown.totalTokens.toLocaleString("en-US") : "unknown";
	const window =
		breakdown.contextWindow != null ? breakdown.contextWindow.toLocaleString("en-US") : "?";
	const pct =
		breakdown.percent != null ? `${breakdown.percent.toFixed(1)}%` : "n/a";

	lines.push(`Context ${total} / ${window} · ${pct}`);
	if (breakdown.safeUsage) {
		lines.push(`Safe input ${total} / ${breakdown.safeUsage.safeInputLimit.toLocaleString("en-US")} · ${breakdown.safeUsage.percent.toFixed(1)}%`);
		lines.push(`Safe remaining ${breakdown.safeUsage.remainingTokens.toLocaleString("en-US")} tokens (model max output + 16,384 reserve)`);
	}
	if (breakdown.totalTokens == null) {
		lines.push("(Total unknown until next model response; categories are estimates)");
	}
	lines.push("");
	lines.push("Categories (estimated)");

	for (const key of ORDER) {
		const value = breakdown.categories[key];
		if (value <= 0 && key !== "unclassified") continue;
		const label = CATEGORY_LABELS[key].padEnd(28, " ");
		const extra = key === "images" && breakdown.imageCount > 0 ? ` (${breakdown.imageCount})` : "";
		lines.push(`${label}${formatToken(value)}${extra}`);
	}

	lines.push("");
	lines.push("Largest Entries");
	const largest = topEntries(breakdown.entries, topN);
	if (largest.length === 0) {
		lines.push("(none)");
	} else {
		largest.forEach((entry, i) => {
			lines.push(`${i + 1}. ${entry.label.padEnd(20, " ")} ${formatToken(entry.tokens)}`);
		});
	}

	lines.push("");
	lines.push("Note: category tokens are estimates (~); cannot precisely attribute AGENTS/skills/tool schemas.");
	return lines;
}

function detailLines(entries: EntryEstimate[], topN: number): string[] {
	const lines: string[] = ["Largest entry details", ""];
	const largest = topEntries(entries, topN);
	if (largest.length === 0) {
		lines.push("(none)");
		return lines;
	}
	for (const [i, entry] of largest.entries()) {
		lines.push(`${i + 1}. ${entry.label}`);
		lines.push(`   category: ${entry.category}`);
		if (entry.toolName) lines.push(`   tool: ${entry.toolName}`);
		lines.push(`   chars: ${entry.chars.toLocaleString("en-US")}  tokens: ${formatToken(entry.tokens)}`);
		lines.push(`   preview: ${redactPreview(entry.preview, 300)}`);
		lines.push("");
	}
	return lines;
}

function textSummary(breakdown: InspectorBreakdown, topN: number): string {
	return [...summaryLines(breakdown, topN), "", ...detailLines(breakdown.entries, Math.min(5, topN))].join("\n");
}

async function showOverlay(
	ctx: ExtensionCommandContext,
	title: string,
	lines: string[],
	footer: string,
	allowCompact: boolean,
): Promise<OverlayAction> {
	return await ctx.ui.custom<OverlayAction>(
		(tui, theme, _kb, done) =>
			new TextOverlay(
				theme,
				{
					title,
					lines,
					footer,
					...(allowCompact ? { extraKeys: [{ key: "x", action: "extra" as const, hint: "compact" }] } : {}),
				},
				done,
				() => tui.requestRender(),
			),
		{ overlay: true },
	);
}

async function runContextConfig(ctx: ExtensionCommandContext): Promise<void> {
	const paths = resolveConfigPaths(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), CONFIG_DIR_NAME);
	const loadScopes = () => ({
		global: loadConfig(ctx.cwd, getAgentDir(), false, CONFIG_DIR_NAME),
		effective: loadConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), CONFIG_DIR_NAME),
	});
	if (!ctx.hasUI || ctx.mode !== "tui") {
		const { global, effective } = loadScopes();
		report(ctx, [
			`Global top entries: ${global.config.context.topEntries} (package default ${DEFAULT_CONFIG.context.topEntries})`,
			`Effective top entries: ${effective.config.context.topEntries}`,
			`Sources: ${paths.join(" -> ")}`,
			"Use /context config in TUI to edit global or trusted-project scope.",
		].join("\n"));
		return;
	}
	let scope = "global" as "global" | "project";
	while (true) {
		const { global, effective } = loadScopes();
		for (const warning of effective.warnings) report(ctx, warning, "warning");
		const targetPath = scope === "project" ? paths[1]! : paths[0]!;
		const target = scope === "global" ? global.config : effective.config;
		const options = [
			...(paths.length > 1 ? [`Scope: ${scope}`] : []),
			`Write target top entries: ${target.context.topEntries}`,
			"Reset override",
			"Show effective config",
			"Done",
		];
		const choice = await selectMenu(ctx, [
			"Context configuration",
			`write: ${scope} (${targetPath})`,
			`effective: ${effective.config.context.topEntries}`,
			`source: ${paths.join(" -> ")}`,
		].join("\n"), options);
		if (!choice || choice === "Done") return;
		if (choice.startsWith("Scope:")) {
			const selected = await selectMenu(ctx, "Context config scope", ["global", "project"], { cancelAction: "back" });
			if (selected === "global" || selected === "project") scope = selected;
			continue;
		}
		if (choice.startsWith("Write target top entries:")) {
			const raw = await ctx.ui.input("Largest entries to show (1-100)", String(target.context.topEntries));
			if (raw === undefined || !raw.trim()) continue;
			if (!/^\d+$/.test(raw.trim())) {
				ctx.ui.notify("Top entries must be an integer from 1 to 100", "warning");
				continue;
			}
			const topEntries = Number.parseInt(raw.trim(), 10);
			if (topEntries < 1 || topEntries > 100) {
				ctx.ui.notify("Top entries must be an integer from 1 to 100", "warning");
				continue;
			}
			const result = updateContextConfig(targetPath, (context) => { context.topEntries = topEntries; });
			if (!result.ok) ctx.ui.notify(`Failed to update terrific.json: ${result.error}`, "error");
			else ctx.ui.notify(`Top entries: ${topEntries}`, "info");
			continue;
		}
		if (choice === "Reset override") {
			if (!await ctx.ui.confirm("Reset context override?", `Remove topEntries from ${scope} scope while preserving other context settings?`)) continue;
			const result = updateContextConfig(targetPath, (context) => { delete context.topEntries; });
			if (!result.ok) ctx.ui.notify(`Failed to update terrific.json: ${result.error}`, "error");
			else ctx.ui.notify(`${scope} context override reset`, "info");
			continue;
		}
		report(ctx, [
			`Global top entries: ${global.config.context.topEntries} (package default ${DEFAULT_CONFIG.context.topEntries})`,
			`Effective top entries: ${effective.config.context.topEntries}`,
			`Sources: ${paths.join(" -> ")}`,
			`Write scope: ${scope} (${targetPath})`,
		].join("\n"));
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Inspect context usage (summary|details|config; TUI: c copy, x confirmed compact)",
		getArgumentCompletions: (prefix) => ["summary", "details", "config"].filter((option) => option.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const { config, warnings } = loadConfig(
				ctx.cwd,
				getAgentDir(),
				ctx.isProjectTrusted(),
				CONFIG_DIR_NAME,
			);
			for (const warning of warnings) report(ctx, warning, "warning");

			const action = args.trim().toLowerCase();
			if (action === "config") {
				await runContextConfig(ctx);
				return;
			}
			const breakdown = buildBreakdown(ctx);
			const topN = config.context.topEntries;
			if (action === "summary") {
				report(ctx, summaryLines(breakdown, topN).join("\n"));
				return;
			}
			if (action === "details") {
				report(ctx, detailLines(breakdown.entries, topN).join("\n"));
				return;
			}
			if (action) {
				report(ctx, "Usage: /context [summary|details|config]", "warning");
				return;
			}

			if (!ctx.hasUI || ctx.mode !== "tui") {
				report(ctx, textSummary(breakdown, topN));
				return;
			}

			let view: "summary" | "details" = "summary";
			while (true) {
				const lines = view === "summary" ? summaryLines(breakdown, topN) : detailLines(breakdown.entries, topN);
				const footer =
					view === "summary"
						? "[c] copy  [x] compact  [Enter] details  [Esc] close"
						: "[c] copy  [Enter] back  [Esc] close";

				const overlayAction = await showOverlay(ctx, "Context Inspector", lines, footer, view === "summary");

				if (overlayAction === "close") return;

				if (overlayAction === "copy") {
					try {
						await copyToClipboard(lines.join("\n"));
						ctx.ui.notify("Copied to clipboard", "info");
					} catch {
						ctx.ui.notify("Copy failed", "error");
					}
					continue;
				}

				if (overlayAction === "extra" && view === "summary") {
					const ok = await ctx.ui.confirm("Compact session?", "Run ctx.compact() now?");
					if (ok) {
						ctx.compact({
							onComplete: () => ctx.ui.notify("Compaction complete", "info"),
							onError: (error) => ctx.ui.notify(`Compaction failed: ${error.message}`, "error"),
						});
					}
					return;
				}

				if (overlayAction === "enter") {
					view = view === "summary" ? "details" : "summary";
					continue;
				}

				return;
			}
		},
	});
}
