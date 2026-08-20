import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";

import { ArtifactJournal, captureGitSnapshot } from "../lib/artifacts.ts";
import { installPresentationCompatibility } from "../lib/compat/index.ts";
import {
	DEFAULT_PRESENTATION_CONFIG,
	loadPresentationConfig,
	updatePresentationConfig,
} from "../lib/config.ts";
import { renderSystemEntry } from "../lib/render.ts";
import { selectMenu } from "../lib/select-menu.ts";
import {
	EntryDeduper,
	appendAnswerContract,
	isPresentationEvent,
	isPresentationSystemEntry,
	makeSystemEntry,
	makeWorkspaceEntry,
} from "../lib/system-events.ts";
import {
	PRESENTATION_ARTIFACT_ENTRY_TYPE,
	PRESENTATION_ARTIFACT_STATE_ENTRY_TYPE,
	PRESENTATION_EVENT_NAME,
	PRESENTATION_SYSTEM_ENTRY_TYPE,
	PRESENTATION_TOOL_ENTRY_TYPE,
	type PresentationArtifactState,
	type PresentationConfig,
	type PresentationSystemEntry,
} from "../lib/types.ts";

function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") process.stdout.write(`${message}\n`);
	else ctx.ui.notify(message, level);
}

function modelRef(model: { provider?: unknown; id?: unknown } | undefined): string | undefined {
	if (typeof model?.provider !== "string" || typeof model.id !== "string") return undefined;
	return `${model.provider}/${model.id}`;
}

function transcriptEntries(ctx: ExtensionContext): unknown[] {
	const manager = ctx.sessionManager as typeof ctx.sessionManager & { buildContextEntries?: () => unknown[] };
	return manager.buildContextEntries?.() ?? manager.getBranch();
}

export default function presentation(pi: ExtensionAPI): void {
	const bootstrap = loadPresentationConfig(getAgentDir());
	let config: PresentationConfig = bootstrap.config;
	const compactToolsActive = () => config.enabled && config.compactTools;
	const ompStyleActive = () => config.enabled && config.style === "omp";
	let configErrorNotified = false;
	let hostErrorNotified = false;
	let latestContext: ExtensionContext | undefined;
	const skillByPath = new Map<string, string>();
	const resolveSkillName = (args: unknown, cwd: string): string | undefined => {
		if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
		const record = args as Record<string, unknown>;
		const value = record.path ?? record.file_path ?? record.filePath ?? record.file;
		if (typeof value !== "string" || !value.trim()) return undefined;
		return skillByPath.get(isAbsolute(value) ? resolve(value) : resolve(cwd, value));
	};
	const compatibility = installPresentationCompatibility({
		isUserMessageBoxEnabled: () => config.enabled && config.userMessageBox,
		isCompactToolsEnabled: compactToolsActive,
		isOmpStyleEnabled: ompStyleActive,
		isArtifactProjectionEnabled: () => config.enabled && config.artifacts,
		getTheme: () => latestContext?.ui.theme,
		resolveSkillName,
	});
	let modelTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingModel: string | undefined;
	let pendingThinking: string | undefined;
	let currentRequestId: string | undefined;
	const deduper = new EntryDeduper();
	const journal = new ArtifactJournal();
	let unsubscribeEvent: (() => void) | undefined;

	const reloadConfig = (ctx: ExtensionContext): void => {
		const loaded = loadPresentationConfig(getAgentDir());
		config = loaded.config;
		if (loaded.error && !configErrorNotified) {
			configErrorNotified = true;
			report(ctx, `Presentation disabled: ${loaded.error}`, "warning");
		}
	};

	const appendSystem = (entry: PresentationSystemEntry | undefined, ctx: ExtensionContext | undefined): boolean => {
		if (!entry || !ctx || !config.enabled || !config.systemEvents || ctx.mode !== "tui") return false;
		if (!deduper.accept(entry)) return false;
		pi.appendEntry(PRESENTATION_SYSTEM_ENTRY_TYPE, entry);
		return true;
	};

	const appendArtifactState = (state: PresentationArtifactState | undefined, ctx: ExtensionContext): void => {
		if (!state || !config.enabled || !config.artifacts || ctx.mode !== "tui") return;
		pi.appendEntry(PRESENTATION_ARTIFACT_STATE_ENTRY_TYPE, state);
		compatibility.setArtifact(state);
	};

	const hydrateDeduper = (ctx: ExtensionContext): void => {
		const entries: PresentationSystemEntry[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== PRESENTATION_SYSTEM_ENTRY_TYPE) continue;
			if (isPresentationSystemEntry(entry.data)) entries.push(entry.data);
		}
		deduper.hydrate(entries);
	};


	const statusReport = (): string => {
		const commands = pi.getCommands();
		const taskboard = commands.some((command) => command.name === "taskboard");
		const toolMode = compactToolsActive() ? "compatibility renderer active" : "native rows";
		return [
			`Presentation: ${config.enabled ? "on" : "off"}`,
			`style=${config.style} workspace=${config.workspace ? "on" : "off"} system=${config.systemEvents ? "on" : "off"} user=${config.style === "omp" ? "native-band" : config.userMessageBox ? "box" : "native"} artifacts=${config.artifacts ? "on" : "off"} tools=${config.compactTools ? "compact" : "native"} expanded=${config.maxExpandedArtifacts}`,
			`integration: tools=${toolMode} taskboard=${taskboard ? "available" : "missing"}`,
		].join("\n");
	};

	const persistConfig = (ctx: ExtensionContext, patch: Partial<PresentationConfig>, success: string): boolean => {
		const result = updatePresentationConfig(getAgentDir(), patch);
		if (!result.ok) {
			report(ctx, `Failed to update presentation config: ${result.error}`, "error");
			return false;
		}
		reloadConfig(ctx);
		report(ctx, success);
		return true;
	};

	const runConfiguration = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			report(ctx, statusReport());
			return;
		}
		while (true) {
			const choice = await selectMenu(ctx, [
				"Presentation configuration",
				`write: ${getAgentDir()}/terrific.json`,
				"System entries own discrete state changes; tool summaries own read/search/command history; file receipts own successful mutations.",
			].join("\n"), [
				`Presentation: ${config.enabled ? "on" : "off"}`,
				`Transcript style: ${config.style}`,
				`Workspace entry: ${config.workspace ? "on" : "off"}`,
				`System entries: ${config.systemEvents ? "on" : "off"}`,
				`User message box: ${config.userMessageBox ? "on" : "off"}`,
				`Compact tool summaries: ${config.compactTools ? "on" : "off"}`,
				`File receipts: ${config.artifacts ? "on" : "off"}`,
				`Expanded file rows: ${config.maxExpandedArtifacts}`,
				"Show integration status",
				"Reset defaults",
				"Done",
			]);
			if (!choice || choice === "Done") return;
			if (choice.startsWith("Presentation:")) {
				persistConfig(ctx, { enabled: !config.enabled }, `Presentation ${config.enabled ? "off" : "on"}`);
			} else if (choice.startsWith("Transcript style:")) {
				const style = config.style === "omp" ? "classic" : "omp";
				persistConfig(ctx, { style }, `Transcript style: ${style}`);
			} else if (choice.startsWith("Workspace entry:")) {
				persistConfig(ctx, { workspace: !config.workspace }, `Workspace entry ${config.workspace ? "off" : "on"}`);
			} else if (choice.startsWith("System entries:")) {
				persistConfig(ctx, { systemEvents: !config.systemEvents }, `System entries ${config.systemEvents ? "off" : "on"}`);
			} else if (choice.startsWith("User message box:")) {
				persistConfig(ctx, { userMessageBox: !config.userMessageBox }, `User message box ${config.userMessageBox ? "off" : "on"}`);
			} else if (choice.startsWith("Compact tool summaries:")) {
				const next = !config.compactTools;
				persistConfig(ctx, { compactTools: next }, `Compact tool summaries ${next ? "on" : "off"}`);
			} else if (choice.startsWith("File receipts:")) {
				persistConfig(ctx, { artifacts: !config.artifacts }, `File receipts ${config.artifacts ? "off" : "on"}`);
			} else if (choice.startsWith("Expanded file rows:")) {
				const value = await ctx.ui.input("Expanded file rows (1-32)", String(config.maxExpandedArtifacts));
				if (value === undefined) continue;
				const next = Number(value.trim());
				if (!Number.isInteger(next) || next < 1 || next > 32) {
					report(ctx, "Expanded file rows must be an integer from 1 to 32", "warning");
					continue;
				}
				persistConfig(ctx, { maxExpandedArtifacts: next }, `Expanded file rows: ${next}`);
			} else if (choice === "Show integration status") {
				report(ctx, statusReport());
			} else if (choice === "Reset defaults") {
				const confirmed = await ctx.ui.confirm("Reset presentation defaults?", "Restore all presentation settings while preserving other terrific.json sections?");
				if (confirmed) persistConfig(ctx, DEFAULT_PRESENTATION_CONFIG, "Presentation defaults restored");
			}
		}
	};

	const captureGit = async (ctx: ExtensionContext, baseHead?: string) => captureGitSnapshot(
		(args) => pi.exec("git", args, { cwd: ctx.cwd, timeout: 3_000 }),
		ctx.cwd,
		baseHead,
	);

	const flushModelSelection = () => {
		modelTimer = undefined;
		const ctx = latestContext;
		if (!ctx || !config.enabled || !config.systemEvents) return;
		const model = pendingModel;
		const thinking = pendingThinking;
		pendingModel = undefined;
		pendingThinking = undefined;
		if (model) {
			appendSystem(makeSystemEntry({
				kind: "model",
				label: "Model",
				message: `${model}${thinking ? ` · thinking ${thinking}` : ""}`,
				dedupeKey: `model:${model}:thinking:${thinking ?? ""}`,
			}), ctx);
		} else if (thinking) {
			appendSystem(makeSystemEntry({
				kind: "thinking",
				label: "Thinking",
				message: thinking,
				dedupeKey: `thinking:${thinking}`,
			}), ctx);
		}
	};

	const scheduleModelSelection = (ctx: ExtensionContext) => {
		latestContext = ctx;
		if (modelTimer) clearTimeout(modelTimer);
		modelTimer = setTimeout(flushModelSelection, 100);
		modelTimer.unref();
	};

	pi.registerEntryRenderer<PresentationSystemEntry>(PRESENTATION_SYSTEM_ENTRY_TYPE, (entry, { expanded }, theme) => {
		if (!isPresentationSystemEntry(entry.data)) return undefined;
		return renderSystemEntry(entry.data, expanded, theme);
	});
	// v1 receipts were per-turn deltas. The v2 state is projected onto its anchor
	// tool row, so legacy receipts remain in JSONL but no longer duplicate history.
	pi.registerEntryRenderer(PRESENTATION_ARTIFACT_ENTRY_TYPE, () => undefined);
	// Legacy semantic entries duplicate the original tool call/result history.
	pi.registerEntryRenderer(PRESENTATION_TOOL_ENTRY_TYPE, () => undefined);

	pi.registerCommand("presentation", {
		description: "Configure low-noise transcript presentation",
		getArgumentCompletions(prefix) {
			return ["config", "on", "off", "status", "reset", "style omp", "style classic", "workspace on", "workspace off", "system on", "system off", "user on", "user off", "tools on", "tools off", "artifacts on", "artifacts off"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			reloadConfig(ctx);
			const action = args.trim().toLowerCase();
			if (action === "" || action === "config") {
				await runConfiguration(ctx);
				return;
			}
			if (action === "status") {
				report(ctx, statusReport());
				return;
			}
			const patch = action === "on" ? { enabled: true }
				: action === "off" ? { enabled: false }
				: action === "style omp" ? { style: "omp" as const }
				: action === "style classic" ? { style: "classic" as const }
				: action === "workspace on" ? { workspace: true }
				: action === "workspace off" ? { workspace: false }
				: action === "system on" ? { systemEvents: true }
				: action === "system off" ? { systemEvents: false }
				: action === "user on" ? { userMessageBox: true }
				: action === "user off" ? { userMessageBox: false }
				: action === "tools on" ? { compactTools: true }
				: action === "tools off" ? { compactTools: false }
				: action === "artifacts on" ? { artifacts: true }
				: action === "artifacts off" ? { artifacts: false }
				: action === "reset" ? DEFAULT_PRESENTATION_CONFIG
				: undefined;
			if (!patch) {
				report(ctx, "Usage: /presentation [config|status|reset|on|off|style omp|style classic|workspace on|workspace off|system on|system off|user on|user off|tools on|tools off|artifacts on|artifacts off]", "error");
				return;
			}
			persistConfig(ctx, patch, "Presentation configuration updated");
		},
	});

	unsubscribeEvent = pi.events.on(PRESENTATION_EVENT_NAME, (value) => {
		if (!isPresentationEvent(value) || value.source !== "user") return;
		if (appendSystem(makeSystemEntry({
			kind: value.kind,
			tone: value.tone,
			label: value.label,
			message: value.message,
			dedupeKey: value.dedupeKey,
		}), latestContext)) value.presentationHandled = true;
	});

	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		reloadConfig(ctx);
		if (!compatibility.host.supported && !hostErrorNotified) {
			hostErrorNotified = true;
			ctx.ui.notify(`Presentation compatibility disabled: ${compatibility.host.reason}`, "warning");
		}
		hydrateDeduper(ctx);
		compatibility.hydrate(transcriptEntries(ctx), ctx.cwd);
		await journal.begin(ctx.cwd);
	});

	pi.on("session_tree", async (_event, ctx) => {
		latestContext = ctx;
		compatibility.assistantReset();
		hydrateDeduper(ctx);
		compatibility.hydrate(transcriptEntries(ctx), ctx.cwd);
		await journal.begin(ctx.cwd);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		latestContext = ctx;
		reloadConfig(ctx);
		currentRequestId = ctx.sessionManager.getLeafId() ?? undefined;
		skillByPath.clear();
		for (const skill of event.systemPromptOptions?.skills ?? []) {
			if (skill.name && skill.filePath) skillByPath.set(resolve(skill.filePath), skill.name);
		}
		compatibility.toolBoundary();
		if (!config.enabled) return;
		await journal.begin(ctx.cwd, config.artifacts ? await captureGit(ctx) : undefined, currentRequestId ?? `request:${Date.now()}`);
		if (config.workspace) {
			let branch: string | undefined;
			try {
				const result = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd, timeout: 3_000 });
				branch = result.code === 0 ? result.stdout.trim() || undefined : undefined;
			} catch {}
			appendSystem(makeWorkspaceEntry({
				cwd: ctx.cwd,
				branch,
				ruleCount: event.systemPromptOptions?.contextFiles?.length ?? 0,
			}), ctx);
		}
		return { systemPrompt: appendAnswerContract(event.systemPrompt) };
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") return;
		pendingModel = modelRef(event.model);
		pendingThinking = String(pi.getThinkingLevel());
		scheduleModelSelection(ctx);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		pendingModel ??= modelRef(ctx.model);
		pendingThinking = String(event.level);
		scheduleModelSelection(ctx);
	});

	pi.on("input", async (event, ctx) => {
		latestContext = ctx;
		if (!config.enabled || !config.systemEvents) return;
		const match = /^\/skill:([A-Za-z0-9_-]+)(?:\s|$)/.exec(event.text.trim());
		if (!match) return;
		const name = match[1]!;
		if (!pi.getCommands().some((command) => command.source === "skill" && command.name === `skill:${name}`)) return;
		appendSystem(makeSystemEntry({
			kind: "skill",
			label: `Skill(${name})`,
			message: "invoked",
			dedupeKey: `skill:${name}:${Date.now()}`,
		}), ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		latestContext = ctx;
		compatibility.assistantStart(event.message);
	});

	pi.on("message_update", async (event, ctx) => {
		latestContext = ctx;
		compatibility.assistantUpdate(event.message);
	});

	pi.on("message_end", async (event, ctx) => {
		latestContext = ctx;
		compatibility.assistantEnd(event.message);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		latestContext = ctx;
		compatibility.toolStart({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			cwd: ctx.cwd,
			...(currentRequestId ? { requestId: currentRequestId } : {}),
			...(event.toolName === "read" && resolveSkillName(event.args, ctx.cwd) ? { skillName: resolveSkillName(event.args, ctx.cwd) } : {}),
		});
	});

	pi.on("tool_call", async (event, ctx) => {
		latestContext = ctx;
		if (!config.enabled || !config.artifacts) return;
		await journal.startTool(event.toolCallId, event.toolName, event.input);
	});

	pi.on("tool_result", async (event, ctx) => {
		latestContext = ctx;
		if (!config.enabled || !config.artifacts) return;
		journal.confirmTool(event.toolCallId, event.toolName, event.input);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		latestContext = ctx;
		compatibility.toolEnd({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
		});
		if (!config.enabled || !config.artifacts) return;
		journal.endTool(event.toolCallId, event.toolName, event.result, event.isError);
	});

	pi.on("turn_end", async (event, ctx) => {
		latestContext = ctx;
		compatibility.toolBoundary();
		if (!config.enabled || !config.artifacts || !Array.isArray(event.toolResults) || event.toolResults.length === 0) return;
		appendArtifactState(await journal.snapshot(event.turnIndex, event.toolResults, await captureGit(ctx, journal.baseHead())), ctx);
	});

	pi.on("agent_settled", async () => {
		// Normal artifact state is deliberately published during tool turns so it
		// precedes the final answer. Settling only releases runtime state.
	});

	pi.on("session_shutdown", async () => {
		compatibility.assistantReset();
		compatibility.uninstall();
		if (modelTimer) clearTimeout(modelTimer);
		modelTimer = undefined;
		unsubscribeEvent?.();
		unsubscribeEvent = undefined;
		latestContext = undefined;
	});
}
