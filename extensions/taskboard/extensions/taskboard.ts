import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { ActivityTracker } from "../lib/activity.ts";
import { loadTaskboardActivityMode, loadTaskboardDefault, updateTaskboardConfig } from "../lib/config.ts";
import { TaskboardWidget, renderToolResult } from "../lib/render.ts";
import { selectMenu } from "../lib/select-menu.ts";
import {
	buildContextReminder,
	createPersistedState,
	createTombstone,
	interruptSnapshot,
	isProcessSnapshot,
	normalizeProcessUpdate,
	recordAssistantUsage,
	restoreProcessState,
	sanitizeProcessText,
	settleSnapshot,
	syncProcessTelemetry,
} from "../lib/state.ts";
import {
	TASKBOARD_CONTEXT_TYPE,
	TASKBOARD_ENTRY_TYPE,
	TASKBOARD_STATUS_KEY,
	TASKBOARD_WIDGET_KEY,
	ProcessUpdateParams,
	type PersistedTaskboardState,
	type TaskboardActivityMode,
	type TaskboardRenderState,
	type ProcessSnapshot,
	type ProcessTelemetry,
	type TaskboardViewMode,
	type RuntimeControlState,
} from "../lib/types.ts";

const PROMPT_GUIDELINES = [
	"Use process_update for work with at least three meaningful user-visible steps; skip it for simple answers or one-step work.",
	"Call process_update only when the task starts, a step changes, work blocks, or the task completes; never use it to narrate private reasoning.",
	"Keep process_update to at most five outcome-oriented steps and mark completed only after requested verification is actually run.",
	"In process_update, use status waiting when paused for a subagent or external process; use blocked when user input is required.",
	"When the presentation file ledger is active, do not repeat ordinary file artifacts in process_update; keep tests, screenshots, URLs, commits, and reports when useful.",
];

function cloneSnapshot(snapshot: ProcessSnapshot): ProcessSnapshot {
	return createPersistedState(snapshot, "compact").snapshot!;
}

function snapshotFingerprint(snapshot: ProcessSnapshot): string {
	const { version, title, status, steps, update, blocker, verification, artifacts, startedAt, updatedAt } = snapshot;
	return JSON.stringify({ version, title, status, steps, update, blocker, verification, artifacts, startedAt, updatedAt });
}

function isUnfinished(snapshot: ProcessSnapshot | undefined): snapshot is ProcessSnapshot {
	return Boolean(snapshot && snapshot.status !== "completed");
}

function taskboardSummary(state: PersistedTaskboardState): string {
	const snapshot = state.snapshot;
	if (!snapshot) return `Taskboard: ${state.viewMode} · no active task`;
	const done = snapshot.steps.filter((step) => step.status === "done").length;
	return `Taskboard: ${state.viewMode} · ${snapshot.status} ${done}/${snapshot.steps.length} · ${snapshot.title}`;
}

const COMMIT_HASH = /^[0-9a-f]{7,64}$/i;

interface GitFinalizeReceipt {
	kind: "git_finalize";
	version: 1;
	status: "committed" | "pushed" | "partial";
	commit: string;
	requestedPush: boolean;
	operationSatisfied: boolean;
	pushError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGitFinalizeReceipt(value: unknown): value is GitFinalizeReceipt {
	if (!isRecord(value)
		|| value.kind !== "git_finalize"
		|| value.version !== 1
		|| (value.status !== "committed" && value.status !== "pushed" && value.status !== "partial")
		|| typeof value.commit !== "string"
		|| !COMMIT_HASH.test(value.commit)
		|| typeof value.requestedPush !== "boolean"
		|| typeof value.operationSatisfied !== "boolean") return false;
	if (!value.requestedPush && value.status !== "committed") return false;
	if (value.requestedPush && value.status === "committed") return false;
	if (value.status === "partial") return value.operationSatisfied === false;
	return value.operationSatisfied === true;
}

function gitFinalizeEligible(snapshot: ProcessSnapshot | undefined): snapshot is ProcessSnapshot {
	if (!snapshot || snapshot.status !== "running") return false;
	const active = snapshot.steps.findIndex((step) => step.status === "active");
	return active === snapshot.steps.length - 1 && snapshot.steps.slice(0, -1).every((step) => step.status === "done");
}

function gitArtifact(snapshot: ProcessSnapshot, commit: string) {
	const short = commit.slice(0, 12);
	const existing = snapshot.artifacts.filter((artifact) => artifact.kind !== "commit");
	return [...existing, { kind: "commit" as const, label: `Committed ${short}`, ref: commit }].slice(-5);
}

function completeFromGit(snapshot: ProcessSnapshot, receipt: GitFinalizeReceipt, now: number): ProcessSnapshot {
	const short = receipt.commit.slice(0, 12);
	return {
		...snapshot,
		status: "completed",
		steps: snapshot.steps.map((step) => ({ ...step, status: "done" as const })),
		update: `Committed ${short}`,
		artifacts: gitArtifact(snapshot, receipt.commit),
		updatedAt: now,
	};
}

function partialFromGit(snapshot: ProcessSnapshot, receipt: GitFinalizeReceipt, now: number): ProcessSnapshot {
	const short = receipt.commit.slice(0, 12);
	const pushError = receipt.pushError ? sanitizeProcessText(receipt.pushError).slice(0, 160) : "";
	const active = snapshot.steps.findIndex((step) => step.status === "active");
	return {
		...snapshot,
		status: "waiting",
		steps: snapshot.steps.map((step, index) => index === active ? { ...step, status: "failed" as const } : { ...step }),
		update: `Committed ${short}; push failed${pushError ? `: ${pushError}` : ""}`,
		artifacts: gitArtifact(snapshot, receipt.commit),
		updatedAt: now,
	};
}

export default function taskboard(pi: ExtensionAPI) {
	let state: PersistedTaskboardState = createPersistedState(undefined, "compact");
	let activityMode: TaskboardActivityMode = "full";
	let control: RuntimeControlState = { requestStarted: false };
	const activity = new ActivityTracker();
	let widgetMounted = false;
	let requestWidgetRender: (() => void) | undefined;
	let durationTickTimer: ReturnType<typeof setInterval> | undefined;
	let getToolsExpanded: (() => boolean) | undefined;
	let pendingTelemetry: ProcessTelemetry | undefined;
	let telemetryDirty = false;
	let uiFailureNotified = false;
	let corruptStateNotified = false;

	const renderState = (): TaskboardRenderState => {
		let expanded = false;
		try {
			expanded = getToolsExpanded?.() ?? false;
		} catch {}
		return {
			viewMode: state.viewMode,
			activityMode,
			...(state.snapshot ? { snapshot: state.snapshot } : {}),
			...(state.telemetry ? { telemetry: state.telemetry } : {}),
			activity: activity.getSnapshot(),
			expanded,
			now: Date.now(),
		};
	};

	const shouldShowWidget = (): boolean => {
		if (state.viewMode === "off") return false;
		if (state.snapshot) {
			return state.snapshot.status !== "completed"
				|| control.requestStarted
				|| activity.getSnapshot().stage !== "settled";
		}
		return activityMode === "full" && activity.getSnapshot().stage !== "settled";
	};

	const notifyUiFailure = (ctx: ExtensionContext, error: unknown) => {
		if (uiFailureNotified) return;
		uiFailureNotified = true;
		const message = error instanceof Error ? error.message : String(error);
		try {
			ctx.ui.notify(`Taskboard UI unavailable: ${message}`, "warning");
		} catch {}
	};

	const stopDurationTick = () => {
		if (!durationTickTimer) return;
		clearInterval(durationTickTimer);
		durationTickTimer = undefined;
	};

	const syncDurationTick = () => {
		const running = widgetMounted
			&& state.viewMode !== "off"
			&& state.snapshot?.status === "running"
			&& state.telemetry?.steps.some((step) => step.activeSince !== undefined);
		if (!running) {
			stopDurationTick();
			return;
		}
		if (durationTickTimer) return;
		durationTickTimer = setInterval(() => requestWidgetRender?.(), 1_000);
		durationTickTimer.unref();
	};

	const syncFooterStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const status = state.snapshot?.status;
		const value = status === "waiting" || status === "blocked" ? status : undefined;
		try {
			ctx.ui.setStatus(TASKBOARD_STATUS_KEY, value);
		} catch (error) {
			notifyUiFailure(ctx, error);
		}
	};

	const refreshWidget = (ctx: ExtensionContext) => {
		syncFooterStatus(ctx);
		if (ctx.mode !== "tui") {
			stopDurationTick();
			return;
		}
		getToolsExpanded = () => ctx.ui.getToolsExpanded();
		try {
			if (!shouldShowWidget()) {
				if (widgetMounted) ctx.ui.setWidget(TASKBOARD_WIDGET_KEY, undefined);
				widgetMounted = false;
				requestWidgetRender = undefined;
				stopDurationTick();
				return;
			}
			if (!widgetMounted) {
				ctx.ui.setWidget(TASKBOARD_WIDGET_KEY, (tui, theme) => {
					const render = () => tui.requestRender();
					requestWidgetRender = render;
					const widget = new TaskboardWidget(renderState, theme);
					return {
						render: (width: number) => widget.render(width),
						invalidate: () => widget.invalidate(),
						dispose: () => {
							if (requestWidgetRender === render) requestWidgetRender = undefined;
						},
					};
				});
				widgetMounted = true;
			} else {
				requestWidgetRender?.();
			}
			syncDurationTick();
		} catch (error) {
			stopDurationTick();
			notifyUiFailure(ctx, error);
		}
	};

	const appendState = (next: PersistedTaskboardState) => {
		pi.appendEntry<PersistedTaskboardState>(TASKBOARD_ENTRY_TYPE, next);
		state = next;
		telemetryDirty = false;
	};

	const isCurrentWidgetSnapshot = (details: unknown): boolean => widgetMounted
		&& Boolean(state.snapshot)
		&& isProcessSnapshot(details)
		&& snapshotFingerprint(details) === snapshotFingerprint(state.snapshot!);

	const appendSystemState = (next: PersistedTaskboardState, ctx: ExtensionContext): boolean => {
		try {
			appendState(next);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Taskboard state could not be saved: ${message}`, "error");
			return false;
		}
	};

	const restore = (ctx: ExtensionContext) => {
		const agentDir = getAgentDir();
		activityMode = loadTaskboardActivityMode(agentDir);
		const restored = restoreProcessState(ctx.sessionManager.getBranch(), loadTaskboardDefault(agentDir));
		state = restored.state;
		control = { requestStarted: false };
		activity.reset();
		pendingTelemetry = undefined;
		telemetryDirty = false;
		getToolsExpanded = ctx.mode === "tui" ? () => ctx.ui.getToolsExpanded() : undefined;
		uiFailureNotified = false;
		if (!restored.corrupted && state.snapshot?.status === "running") {
			const running = state.snapshot;
			const waiting = settleSnapshot(running);
			const paused = createPersistedState(
				waiting,
				state.viewMode,
				syncProcessTelemetry(running, state.telemetry, waiting, running.updatedAt),
			);
			if (!appendSystemState(paused, ctx)) state = paused;
		}
		if (restored.corrupted) {
			try {
				pi.appendEntry<PersistedTaskboardState>(TASKBOARD_ENTRY_TYPE, state);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Cleared Taskboard state could not be saved: ${message}`, "error");
			}
			if (!corruptStateNotified) {
				corruptStateNotified = true;
				ctx.ui.notify("Taskboard state was invalid and has been cleared", "warning");
			}
		}
		refreshWidget(ctx);
	};

	pi.registerTool({
		name: "process_update",
		label: "Taskboard update",
		description: "Publish a concise structured Taskboard snapshot of user-visible progress for the current task.",
		promptSnippet: "Publish concise user-visible task progress for non-trivial work",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ProcessUpdateParams,
		executionMode: "sequential",
		renderShell: "self",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const now = Date.now();
			const snapshot = normalizeProcessUpdate(params, state.snapshot, now);
			const telemetry = syncProcessTelemetry(
				state.snapshot,
				state.telemetry ?? (state.snapshot ? undefined : pendingTelemetry),
				snapshot,
				now,
			);
			const next = createPersistedState(snapshot, state.viewMode, telemetry);
			appendState(next);
			pendingTelemetry = undefined;
			control.requestStarted = true;
			refreshWidget(ctx);
			const done = snapshot.steps.filter((step) => step.status === "done").length;
			return {
				content: [{ type: "text", text: `Taskboard state updated: ${done}/${snapshot.steps.length} ${snapshot.status}` }],
				details: { ...snapshot, telemetry },
			};
		},

		renderCall() {
			return new Container();
		},

		renderResult(result, { expanded }, theme, context) {
			const rendered = renderToolResult(result, expanded, context.isError, theme);
			if (expanded || context.isError) return rendered;
			return {
				render: (width: number) => isCurrentWidgetSnapshot(result.details) ? [] : rendered.render(width),
				invalidate: () => rendered.invalidate(),
			};
		},
	});

	const saveViewMode = (mode: TaskboardViewMode, ctx: ExtensionContext) => {
		const next = state.snapshot
			? createPersistedState(state.snapshot, mode, state.telemetry)
			: state.cleared
				? createTombstone(mode)
				: createPersistedState(undefined, mode);
		try {
			appendState(next);
			refreshWidget(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Taskboard mode could not be saved: ${message}`, "error");
		}
	};

	const clearTaskboard = (ctx: ExtensionContext) => {
		try {
			appendState(createTombstone(state.viewMode));
			control.pendingContextReminder = undefined;
			pendingTelemetry = undefined;
			activity.reset();
			refreshWidget(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Taskboard state could not be cleared: ${message}`, "error");
		}
	};

	const confirmClearTaskboard = async (ctx: ExtensionContext) => {
		if (!state.snapshot) {
			ctx.ui.notify("No current task to clear", "warning");
			return;
		}
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("/taskboard clear requires TUI confirmation", "warning");
			return;
		}
		const done = state.snapshot.steps.filter((step) => step.status === "done").length;
		const usage = state.telemetry?.usage;
		const tokens = usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
		const confirmed = await ctx.ui.confirm(
			"Clear current Taskboard task",
			`Clear "${state.snapshot.title}" (${done}/${state.snapshot.steps.length}, ${state.telemetry?.turns ?? 0} turns, ${tokens} tokens)? This removes its saved progress and telemetry.`,
		);
		if (confirmed) clearTaskboard(ctx);
	};

	const setGlobalDefaultViewMode = (ctx: ExtensionContext, mode: TaskboardViewMode) => {
		const result = updateTaskboardConfig(getAgentDir(), mode);
		if (!result.ok) {
			ctx.ui.notify(`Failed to update terrific.json: ${result.error}`, "error");
			return;
		}
		ctx.ui.notify(`Taskboard default for new sessions: ${mode}`, "info");
	};

	const runTaskboardManager = async (ctx: ExtensionContext) => {
		while (true) {
			const expanded = ctx.ui.getToolsExpanded();
			const defaultMode = loadTaskboardDefault(getAgentDir());
			const choice = await selectMenu(ctx, taskboardSummary(state), [
				`View mode: ${state.viewMode}`,
				`Default for new sessions: ${defaultMode}`,
				`${expanded ? "Collapse" : "Expand"} live panel`,
				...(state.snapshot ? ["Clear current task"] : []),
				"Done",
			]);
			if (!choice || choice === "Done") return;
			if (choice.startsWith("View mode:")) {
				const mode = await selectMenu(ctx, "Taskboard view mode", ["compact", "full", "off"], { cancelAction: "back" });
				if (mode === "compact" || mode === "full" || mode === "off") saveViewMode(mode, ctx);
				continue;
			}
			if (choice.startsWith("Default for new sessions:")) {
				const mode = await selectMenu(ctx, "Default Taskboard mode", ["compact", "full", "off"], { cancelAction: "back" });
				if (mode === "compact" || mode === "full" || mode === "off") setGlobalDefaultViewMode(ctx, mode);
				continue;
			}
			if (choice.endsWith("live panel")) {
				ctx.ui.setToolsExpanded(!expanded);
				refreshWidget(ctx);
				continue;
			}
			if (choice === "Clear current task") await confirmClearTaskboard(ctx);
		}
	};

	const taskboardCommand = {
		description: "Manage Taskboard or use compact | full | off | clear | default <mode>",
		getArgumentCompletions(prefix: string) {
			const query = prefix.trimStart().toLowerCase();
			const options = query.startsWith("default")
				? ["default compact", "default full", "default off"]
				: ["compact", "full", "off", "clear", "default"];
			return options
				.filter((value) => value.startsWith(query))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const action = parts[0];
			const usage = "Usage: /taskboard [compact|full|off|clear|default <compact|full|off>]";
			if (!action) {
				if (ctx.mode === "tui") await runTaskboardManager(ctx);
				else ctx.ui.notify(`${taskboardSummary(state)} · global default ${loadTaskboardDefault(getAgentDir())}`, "info");
				return;
			}
			if (action === "default") {
				if (parts.length !== 2) {
					ctx.ui.notify(`Global default: ${loadTaskboardDefault(getAgentDir())}. Usage: /taskboard default <compact|full|off>`, "warning");
					return;
				}
				const mode = parts[1];
				if (mode === "compact" || mode === "full" || mode === "off") setGlobalDefaultViewMode(ctx, mode);
				else ctx.ui.notify(`Global default: ${loadTaskboardDefault(getAgentDir())}. Usage: /taskboard default <compact|full|off>`, "warning");
				return;
			}
			if (parts.length !== 1) {
				ctx.ui.notify(usage, "warning");
				return;
			}
			if (action === "clear") {
				await confirmClearTaskboard(ctx);
				return;
			}
			if (action === "compact" || action === "full" || action === "off") {
				saveViewMode(action, ctx);
				return;
			}
			ctx.ui.notify(usage, "warning");
		},
	};
	pi.registerCommand("taskboard", taskboardCommand);

	pi.on("session_start", async (_event, ctx) => restore(ctx));

	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	pi.on("before_agent_start", async (_event, ctx) => {
		control.requestStarted = true;
		control.pendingStopReason = undefined;
		pendingTelemetry = undefined;
		if (isUnfinished(state.snapshot)) control.pendingContextReminder = cloneSnapshot(state.snapshot);
		if (state.snapshot) appendSystemState(createTombstone(state.viewMode), ctx);
		activity.beginRequest();
		refreshWidget(ctx);
	});

	pi.on("context", async (event) => {
		const snapshot = control.pendingContextReminder;
		if (!snapshot) return;
		control.pendingContextReminder = undefined;
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					customType: TASKBOARD_CONTEXT_TYPE,
					content: buildContextReminder(snapshot),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("session_compact", async () => {
		if (isUnfinished(state.snapshot)) control.pendingContextReminder = cloneSnapshot(state.snapshot);
	});

	pi.on("agent_start", async () => {
		control.pendingStopReason = undefined;
	});

	pi.on("message_update", async (event, ctx) => {
		activity.handleAssistantEvent(event.assistantMessageEvent.type);
		refreshWidget(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (!state.snapshot) {
			if (control.requestStarted) {
				pendingTelemetry = recordAssistantUsage(pendingTelemetry, undefined, event.message);
			}
			return;
		}
		const telemetry = state.telemetry
			?? syncProcessTelemetry(undefined, undefined, state.snapshot);
		state = createPersistedState(
			state.snapshot,
			state.viewMode,
			recordAssistantUsage(telemetry, state.snapshot, event.message),
		);
		telemetryDirty = true;
		refreshWidget(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "git_finalize" || !state.snapshot || state.snapshot.status !== "running") return;
		if (!gitFinalizeEligible(state.snapshot)) {
			return { block: true, reason: "git_finalize can complete Taskboard only when its final active step is ready to commit" };
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "git_finalize" || event.isError || !isGitFinalizeReceipt(event.details)) return;
		const snapshot = state.snapshot;
		if (!gitFinalizeEligible(snapshot)) return;
		const now = Date.now();
		const nextSnapshot = event.details.status === "partial"
			? partialFromGit(snapshot, event.details, now)
			: completeFromGit(snapshot, event.details, now);
		const next = createPersistedState(
			nextSnapshot,
			state.viewMode,
			syncProcessTelemetry(snapshot, state.telemetry, nextSnapshot, now),
		);
		if (!appendSystemState(next, ctx)) state = next;
		refreshWidget(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activity.startTool(event.toolCallId, event.toolName, event.args, ctx.cwd);
		refreshWidget(ctx);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		if (activity.updateTool(event.toolCallId, event.toolName, event.partialResult)) {
			refreshWidget(ctx);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activity.endTool(event.toolCallId, event.toolName, event.isError);
		refreshWidget(ctx);
	});

	pi.on("turn_end", async (event) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
			control.pendingStopReason = event.message.stopReason;
		} else {
			control.pendingStopReason = undefined;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const snapshot = state.snapshot;
		const now = Date.now();
		if (snapshot && control.pendingStopReason && snapshot.status !== "completed") {
			const interrupted = interruptSnapshot(snapshot, control.pendingStopReason, now);
			appendSystemState(
				createPersistedState(
					interrupted,
					state.viewMode,
					syncProcessTelemetry(snapshot, state.telemetry, interrupted, now),
				),
				ctx,
			);
		} else if (snapshot?.status === "running") {
			const settled = settleSnapshot(snapshot, now);
			appendSystemState(
				createPersistedState(
					settled,
					state.viewMode,
					syncProcessTelemetry(snapshot, state.telemetry, settled, now),
				),
				ctx,
			);
		} else if (snapshot && telemetryDirty) {
			appendSystemState(createPersistedState(snapshot, state.viewMode, state.telemetry), ctx);
		}
		control.pendingStopReason = undefined;
		control.requestStarted = false;
		pendingTelemetry = undefined;
		const finalStatus = state.snapshot?.status;
		activity.settle(finalStatus === "waiting" || finalStatus === "blocked" || finalStatus === "interrupted");
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (state.snapshot?.status === "running") {
			const running = state.snapshot;
			const now = Date.now();
			const waiting = settleSnapshot(running, now);
			const paused = createPersistedState(
				waiting,
				state.viewMode,
				syncProcessTelemetry(running, state.telemetry, waiting, now),
			);
			if (!appendSystemState(paused, ctx)) state = paused;
		}
		if (ctx.hasUI) {
			try {
				ctx.ui.setStatus(TASKBOARD_STATUS_KEY, undefined);
				if (ctx.mode === "tui" && widgetMounted) ctx.ui.setWidget(TASKBOARD_WIDGET_KEY, undefined);
			} catch {}
		}
		widgetMounted = false;
		requestWidgetRender = undefined;
		getToolsExpanded = undefined;
		stopDurationTick();
		activity.reset();
		pendingTelemetry = undefined;
		telemetryDirty = false;
		control = { requestStarted: false };
	});
}
