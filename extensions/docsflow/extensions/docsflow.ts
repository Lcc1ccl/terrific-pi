/**
 * /docsflow — project docs workflow over pi-subagents.
 * Default: write under session cwd ./docsflow/
 * Optional: Obsidian vault output when docsflow.vaultEnabled=true
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { runDocsflowSettingsConfigurator } from "../lib/configure.ts";
import { STAGE_AGENT, backupRootFor, describeLocation, resumeFlow, startFlow } from "../lib/flow.ts";
import { loadDocsAgentProfiles } from "../lib/profiles.ts";
import { runDocsflowManager } from "../lib/interaction.ts";
import { report } from "../lib/output.ts";
import {
	DOCSFLOW_STATUS_KEY,
	loadState,
	resetState,
	saveState,
	statusLabel,
	type DocsflowState,
} from "../lib/state.ts";
import {
	defaultProjectSlug,
	loadDocsflowConfig,
	resolveDocsflowOutputRoot,
	updateDocsflowConfig,
	vaultConfigReminder,
} from "../lib/vault.ts";
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
	if (!trimmed) return { action: "", rest: "" };
	const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
	if (!match) return { action: "", rest: "" };
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

	const showStatus = (ctx: ExtensionContext) => {
		const state = loadState(ctx.cwd);
		publishStatus(ctx, state);
		report(ctx, renderStatus(state, ctx.cwd));
	};

	const runFlow = async (
		ctx: ExtensionContext,
		action: "start" | "resume",
		start?: { requirement: string; projectSlug?: string },
	) => {
		if (running) {
			report(ctx, "docsflow already running", "warning");
			return;
		}
		running = true;
		try {
			let result;
			if (action === "start") {
				if (!start?.requirement) {
					report(ctx, "Usage: /docsflow start [--project slug] <requirement>", "warning");
					return;
				}
				maybeRemind(ctx, "report");
				result = await startFlow({
					projectRoot: ctx.cwd,
					requirement: start.requirement,
					projectSlug: start.projectSlug,
					agentDir: getAgentDir(),
					events: pi.events,
					onUpdate: () => publishStatus(ctx, loadState(ctx.cwd)),
				});
			} else {
				result = await resumeFlow({
					projectRoot: ctx.cwd,
					agentDir: getAgentDir(),
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
			saveState(ctx.cwd, state);
			publishStatus(ctx, state);
			report(ctx, message, "error");
		} finally {
			running = false;
		}
	};

	const applyDrafts = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			report(ctx, "/docsflow apply-drafts requires TUI confirmation", "warning");
			return;
		}
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
	};

	const runDraftsMenu = async (ctx: ExtensionContext) => {
		const state = loadState(ctx.cwd);
		const pairs = state.outputRoot ? listDraftArtifacts(state.outputRoot) : [];
		if (pairs.length === 0) {
			report(ctx, "No draft artifacts in docsflow output folder");
			return;
		}
		const choice = await ctx.ui.select("Docsflow drafts", ["Apply drafts", "Show drafts", "Back"]);
		if (!choice || choice === "Back") return;
		if (choice === "Apply drafts") await applyDrafts(ctx);
		else report(ctx, pairs.map((pair) => `${pair.formal} <= ${pair.draft}`).join("\n"));
	};

	const reset = async (ctx: ExtensionContext) => {
		if (running) {
			report(ctx, "Cannot reset while docsflow is running", "error");
			return;
		}
		if (!ctx.hasUI || ctx.mode !== "tui") {
			report(ctx, "/docsflow reset requires TUI confirmation", "warning");
			return;
		}
		if (!await ctx.ui.confirm("Reset docsflow state?", "Clear workflow state only. Markdown product files are not deleted.")) {
			report(ctx, "docsflow reset cancelled", "warning");
			return;
		}
		const state = resetState(ctx.cwd);
		publishStatus(ctx, state);
		report(ctx, "docsflow state reset (markdown product files were not deleted)");
	};

	const runSettings = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			const config = loadDocsflowConfig(getAgentDir());
			report(ctx, JSON.stringify(config, null, 2));
			return;
		}
		try {
			await ctx.modelRegistry.refresh();
		} catch (error) {
			report(ctx, `Could not refresh models: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		const modelCapabilities = [...new Map(ctx.modelRegistry.getAvailable()
			.filter((model) => model.input.includes("text"))
			.map((model) => {
				const ref = `${model.provider}/${model.id}`;
				return [ref, { ref, reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap }] as const;
			})).values()]
			.sort((left, right) => left.ref.localeCompare(right.ref));
		const profiles = new Map(loadDocsAgentProfiles().map((profile) => [profile.name, profile]));
		const stageDefaults = Object.fromEntries(Object.entries(STAGE_AGENT).map(([stage, agent]) => {
			const profile = profiles.get(agent);
			return [stage, {
				...(profile?.model ? { model: profile.model } : {}),
				...(profile?.thinking ? { thinking: profile.thinking } : {}),
				...(profile?.timeoutSeconds ? { timeoutMs: profile.timeoutSeconds * 1_000 } : {}),
			}];
		}));
		await runDocsflowSettingsConfigurator({
			agentDir: getAgentDir(),
			modelRefs: modelCapabilities.map((model) => model.ref),
			modelCapabilities,
			stageDefaults,
			ui: {
				select: (title, options) => ctx.ui.select(title, options),
				input: (title, placeholder) => ctx.ui.input(title, placeholder),
				confirm: (title, message) => ctx.ui.confirm(title, message),
				notify: (message, level) => ctx.ui.notify(message, level),
			},
		});
	};

	const runStartWizard = async (ctx: ExtensionContext) => {
		const requirement = (await ctx.ui.input("Docsflow requirement", ""))?.trim();
		if (!requirement) return;
		let projectSlug: string;
		let outputRoot: string;
		try {
			const suggested = defaultProjectSlug(ctx.cwd);
			const value = await ctx.ui.input("Project slug", suggested);
			if (value === undefined) return;
			projectSlug = defaultProjectSlug(ctx.cwd, value.trim() || undefined);
			outputRoot = resolveDocsflowOutputRoot({
				config: loadDocsflowConfig(getAgentDir()),
				projectRoot: ctx.cwd,
				projectSlug,
			});
		} catch (error) {
			report(ctx, error instanceof Error ? error.message : String(error), "error");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Start docsflow?",
			`Requirement: ${requirement}\nProject: ${projectSlug}\nOutput: ${outputRoot}`,
		);
		if (!confirmed) return;
		await runFlow(ctx, "start", { requirement, projectSlug });
	};

	const runManager = async (ctx: ExtensionContext) => {
		const state = loadState(ctx.cwd);
		await runDocsflowManager({
			title: `Docsflow\n${state.status} · ${state.projectSlug || "no project"} · ${state.currentStage ?? "no active stage"}`,
			ui: { select: (title, options) => ctx.ui.select(title, options) },
			status: async () => showStatus(ctx),
			start: async () => runStartWizard(ctx),
			resume: async () => runFlow(ctx, "resume"),
			drafts: async () => runDraftsMenu(ctx),
			reset: async () => reset(ctx),
			settings: async () => runSettings(ctx),
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (reminded) return;
		reminded = true;
		maybeRemind(ctx, "notify");
	});

	pi.registerCommand("docsflow", {
		description: "Docsflow manager: start|resume|status|reset|apply-drafts|settings|remind",
		getArgumentCompletions: (prefix) => {
			const opts = ["start", "resume", "status", "reset", "apply-drafts", "settings", "remind on", "remind off"];
			const p = prefix.trim().toLowerCase();
			return opts.filter((option) => option.startsWith(p)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			let { action, rest } = parseArgs(args);
			if (!action) {
				if (ctx.hasUI && ctx.mode === "tui") {
					await runManager(ctx);
					return;
				}
				action = "status";
			}

			if (action === "remind") {
				const arg = rest.trim().toLowerCase();
				if (arg === "on" || arg === "off") {
					try {
						const config = updateDocsflowConfig(getAgentDir(), { configReminder: arg === "on" });
						report(ctx, `docsflow config reminder ${config.configReminder ? "ON" : "OFF"} (saved to terrific.json)`);
					} catch (error) {
						report(ctx, `Failed to update terrific.json: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					return;
				}
				const config = loadDocsflowConfig(getAgentDir());
				report(ctx, [`configReminder: ${config.configReminder ? "on" : "off"}`, "Usage: /docsflow remind on|off"].join("\n"));
				return;
			}

			if (action === "status") {
				showStatus(ctx);
				return;
			}
			if (action === "settings") {
				await runSettings(ctx);
				return;
			}
			if (action === "reset") {
				await reset(ctx);
				return;
			}
			if (action === "apply-drafts") {
				await applyDrafts(ctx);
				return;
			}
			if (action !== "start" && action !== "resume") {
				const config = loadDocsflowConfig(getAgentDir());
				const lines = [
					"Usage:",
					"/docsflow                      open manager",
					"/docsflow start [--project slug] <requirement>",
					"/docsflow resume",
					"/docsflow status",
					"/docsflow reset",
					"/docsflow apply-drafts",
					"/docsflow settings",
					"/docsflow remind on|off",
				];
				if (config.configReminder) lines.push("", vaultConfigReminder(config));
				report(ctx, lines.join("\n"), "warning");
				return;
			}
			if (action === "start") {
				const parsed = parseStart(rest);
				await runFlow(ctx, "start", parsed);
			} else {
				await runFlow(ctx, "resume");
			}
		},
	});
}
