/**
 * /docsflow — project docs workflow over pi-subagents.
 * Default: write under session cwd ./docsflow/
 * Optional: Obsidian vault output when docsflow.vaultEnabled=true
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { backupRootFor, describeLocation, resumeFlow, startFlow } from "../lib/flow.ts";
import { report } from "../lib/output.ts";
import {
	DOCSFLOW_STATUS_KEY,
	loadState,
	resetState,
	saveState,
	statusLabel,
	type DocsflowState,
} from "../lib/state.ts";
import { loadDocsflowConfig, updateDocsflowConfig, vaultConfigReminder } from "../lib/vault.ts";
import {
	backupAndApplyDrafts,
	draftDiffSummary,
	listDraftArtifacts,
} from "../lib/write-artifacts.ts";

function renderStatus(state: DocsflowState, cwd: string): string {
	const config = loadDocsflowConfig(getAgentDir());
	const lines = [
		`status: ${state.status}`,
		`requirement: ${state.requirement || "(none)"}`,
		`project: ${state.projectSlug || "(none)"}`,
		`output: ${describeLocation(state, config, cwd)}`,
		`vaultEnabled: ${config.vaultEnabled ? "true" : "false"}`,
		`completed: ${state.completedStages.join(", ") || "(none)"}`,
		`active: ${state.activeAgent ?? "(none)"}`,
		`artifacts: ${state.generatedArtifacts.join(", ") || "(none)"}`,
		`drafts: ${state.draftArtifacts.join(", ") || "(none)"}`,
	];
	if (state.lastError) lines.push(`error: ${state.lastError}`);
	return lines.join("\n");
}

function publishStatus(ctx: ExtensionContext, state: DocsflowState): void {
	ctx.ui.setStatus(DOCSFLOW_STATUS_KEY, statusLabel(state));
}

function parseArgs(args: string): { action: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { action: "status", rest: "" };
	const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
	if (!match) return { action: "status", rest: "" };
	return { action: match[1]!.toLowerCase(), rest: match[2]!.trim() };
}

function parseStart(rest: string): { projectSlug?: string; requirement: string } {
	const projectMatch = rest.match(/^--project\s+(\S+)\s+([\s\S]+)$/);
	if (projectMatch) return { projectSlug: projectMatch[1], requirement: projectMatch[2]!.trim() };
	return { requirement: rest.trim() };
}

export default function docsflow(pi: ExtensionAPI) {
	let running = false;
	let reminded = false;

	const maybeRemind = (ctx: ExtensionContext, mode: "notify" | "report" = "notify") => {
		const config = loadDocsflowConfig(getAgentDir());
		if (!config.configReminder) return;
		const text = vaultConfigReminder(config);
		const level = config.vaultEnabled ? "info" : "warning";
		if (mode === "report") report(ctx, text, level);
		else ctx.ui.notify(text, level);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (reminded) return;
		reminded = true;
		maybeRemind(ctx, "notify");
	});

	pi.registerCommand("docsflow", {
		description: "Docsflow: start|resume|status|reset|apply-drafts|remind",
		getArgumentCompletions: (prefix) => {
			const opts = ["start", "resume", "status", "reset", "apply-drafts", "remind on", "remind off"];
			const p = prefix.trim().toLowerCase();
			return opts.filter((o) => o.startsWith(p)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const { action, rest } = parseArgs(args);

			if (action === "remind") {
				const arg = rest.trim().toLowerCase();
				if (arg === "on" || arg === "off") {
					const config = updateDocsflowConfig(getAgentDir(), { configReminder: arg === "on" });
					report(
						ctx,
						`docsflow config reminder ${config.configReminder ? "ON" : "OFF"} (saved to terrific.json)`,
					);
					return;
				}
				const config = loadDocsflowConfig(getAgentDir());
				report(
					ctx,
					[
						`configReminder: ${config.configReminder ? "on" : "off"}`,
						"Usage: /docsflow remind on|off",
					].join("\n"),
				);
				return;
			}

			if (action === "status") {
				const state = loadState(ctx.cwd);
				publishStatus(ctx, state);
				report(ctx, renderStatus(state, ctx.cwd));
				return;
			}

			if (action === "reset") {
				if (running) {
					report(ctx, "Cannot reset while docsflow is running", "error");
					return;
				}
				const state = resetState(ctx.cwd);
				publishStatus(ctx, state);
				report(ctx, "docsflow state reset (markdown product files were not deleted)");
				return;
			}

			if (action === "apply-drafts") {
				const state = loadState(ctx.cwd);
				if (!state.outputRoot) {
					report(ctx, "No docsflow output root. Run /docsflow start first.", "warning");
					return;
				}
				const pairs = listDraftArtifacts(state.outputRoot);
				if (pairs.length === 0) {
					report(ctx, "No draft artifacts in docsflow output folder");
					return;
				}
				const summary = draftDiffSummary(state.outputRoot, pairs);
				const confirmed = await ctx.ui.confirm(
					"Apply docsflow drafts",
					`Backup formal files, then replace with drafts:\n${summary}`,
				);
				if (!confirmed) {
					report(ctx, "apply-drafts cancelled", "warning");
					return;
				}
				const result = backupAndApplyDrafts({
					outputRoot: state.outputRoot,
					backupRoot: backupRootFor(ctx.cwd),
					pairs,
				});
				state.generatedArtifacts = [...new Set([...state.generatedArtifacts, ...result.applied])];
				state.draftArtifacts = state.draftArtifacts.filter((draft) => !pairs.some((pair) => pair.draft === draft));
				saveState(ctx.cwd, state);
				report(ctx, `Applied ${result.applied.length} draft(s). Backup: ${result.backupDir}\n${result.applied.join("\n")}`);
				return;
			}

			if (action !== "start" && action !== "resume") {
				const config = loadDocsflowConfig(getAgentDir());
				const lines = [
					"Usage:",
					"/docsflow start [--project slug] <requirement>",
					"/docsflow resume",
					"/docsflow status",
					"/docsflow reset",
					"/docsflow apply-drafts",
					"/docsflow remind on|off",
				];
				if (config.configReminder) {
					lines.push("", vaultConfigReminder(config));
				}
				report(ctx, lines.join("\n"), "warning");
				return;
			}

			if (running) {
				report(ctx, "docsflow already running", "warning");
				return;
			}

			running = true;
			try {
				let result;
				if (action === "start") {
					const parsed = parseStart(rest);
					if (!parsed.requirement) {
						report(ctx, "Usage: /docsflow start [--project slug] <requirement>", "warning");
						return;
					}
					maybeRemind(ctx, "report");
					result = await startFlow({
						projectRoot: ctx.cwd,
						requirement: parsed.requirement,
						projectSlug: parsed.projectSlug,
						agentDir: getAgentDir(),
						events: pi.events,
						onUpdate: () => publishStatus(ctx, loadState(ctx.cwd)),
					});
				} else {
					result = await resumeFlow({
						projectRoot: ctx.cwd,
						events: pi.events,
						onUpdate: () => publishStatus(ctx, loadState(ctx.cwd)),
					});
				}
				publishStatus(ctx, result.state);
				report(ctx, `${renderStatus(result.state, ctx.cwd)}\n\n${result.summary}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const state = loadState(ctx.cwd);
				state.status = "failed";
				state.lastError = message;
				state.activeAgent = null;
				state.currentStage = null;
				saveState(ctx.cwd, state);
				publishStatus(ctx, state);
				report(ctx, message, "error");
			} finally {
				running = false;
			}
		},
	});
}
