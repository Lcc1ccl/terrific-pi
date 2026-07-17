/**
 * /context — context occupancy inspector (no model calls, no session writes).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildSessionContext,
	CONFIG_DIR_NAME,
	copyToClipboard,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../lib/config.ts";
import { TextOverlay, type OverlayAction } from "../lib/overlay.ts";
import { report } from "../lib/output.ts";
import { redactPreview } from "../lib/redact.ts";
import {
	analyzeContext,
	CATEGORY_LABELS,
	formatToken,
	topEntries,
	type CategoryKey,
	type ClassifiableMessage,
	type ContextBreakdown,
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

function buildBreakdown(ctx: ExtensionCommandContext): ContextBreakdown {
	const usage = ctx.getContextUsage();
	const systemPrompt = ctx.getSystemPrompt?.() ?? "";
	const sessionCtx = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const messages = (sessionCtx.messages ?? []) as ClassifiableMessage[];

	return analyzeContext({
		systemPrompt,
		messages,
		totalTokens: usage?.tokens ?? null,
		contextWindow: usage?.contextWindow ?? null,
		percent: usage?.percent ?? null,
	});
}

function summaryLines(breakdown: ContextBreakdown, topN: number): string[] {
	const lines: string[] = [];
	const total =
		breakdown.totalTokens != null ? breakdown.totalTokens.toLocaleString("en-US") : "unknown";
	const window =
		breakdown.contextWindow != null ? breakdown.contextWindow.toLocaleString("en-US") : "?";
	const pct =
		breakdown.percent != null ? `${breakdown.percent.toFixed(1)}%` : "n/a";

	lines.push(`Context ${total} / ${window} · ${pct}`);
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

function textSummary(breakdown: ContextBreakdown, topN: number): string {
	return [...summaryLines(breakdown, topN), "", ...detailLines(breakdown.entries, Math.min(5, topN))].join("\n");
}

async function showOverlay(
	ctx: ExtensionCommandContext,
	title: string,
	lines: string[],
	footer: string,
): Promise<OverlayAction> {
	return await ctx.ui.custom<OverlayAction>(
		(tui, theme, _kb, done) =>
			new TextOverlay(
				theme,
				{
					title,
					lines,
					footer,
				},
				done,
				() => tui.requestRender(),
			),
		{ overlay: true },
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Inspect context usage by category (estimated breakdown)",
		handler: async (_args, ctx) => {
			const { config, warnings } = loadConfig(
				ctx.cwd,
				getAgentDir(),
				ctx.isProjectTrusted(),
				CONFIG_DIR_NAME,
			);
			for (const warning of warnings) report(ctx, warning, "warning");

			const breakdown = buildBreakdown(ctx);
			const topN = config.context.topEntries;

			if (!ctx.hasUI || ctx.mode !== "tui") {
				report(ctx, textSummary(breakdown, topN));
				return;
			}

			let view: "summary" | "details" = "summary";
			while (true) {
				const lines = view === "summary" ? summaryLines(breakdown, topN) : detailLines(breakdown.entries, topN);
				const footer =
					view === "summary"
						? "[c] compact  [Enter] details  [Esc] close"
						: "[c] copy  [Enter] back  [Esc] close";

				const action = await showOverlay(ctx, "Context Inspector", lines, footer);

				if (action === "close") return;

				if (action === "copy") {
					if (view === "summary") {
						const ok = await ctx.ui.confirm("Compact session?", "Run ctx.compact() now?");
						if (ok) {
							ctx.compact({
								onComplete: () => ctx.ui.notify("Compaction complete", "info"),
								onError: (error) => ctx.ui.notify(`Compaction failed: ${error.message}`, "error"),
							});
						}
						return;
					}

					try {
						await copyToClipboard(lines.join("\n"));
						ctx.ui.notify("Copied to clipboard", "info");
					} catch {
						ctx.ui.notify("Copy failed", "error");
					}
					continue;
				}

				if (action === "enter") {
					view = view === "summary" ? "details" : "summary";
					continue;
				}

				return;
			}
		},
	});
}
