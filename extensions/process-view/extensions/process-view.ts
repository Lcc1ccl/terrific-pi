import {
	keyText,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { ActivityTracker } from "../lib/activity.ts";
import { ProcessWidget, renderToolResult } from "../lib/render.ts";
import {
	buildContextReminder,
	createPersistedState,
	createTombstone,
	interruptSnapshot,
	normalizeProcessUpdate,
	restoreProcessState,
	settleSnapshot,
} from "../lib/state.ts";
import {
	PROCESS_CONTEXT_TYPE,
	PROCESS_ENTRY_TYPE,
	PROCESS_WIDGET_KEY,
	ProcessUpdateParams,
	type PersistedProcessState,
	type ProcessRenderState,
	type ProcessSnapshot,
	type ProcessViewMode,
	type RuntimeControlState,
} from "../lib/types.ts";

const PROMPT_GUIDELINES = [
	"Use process_update for work with at least three meaningful user-visible steps; skip it for simple answers or one-step work.",
	"Call process_update only when the task starts, a step changes, work blocks, or the task completes; never use it to narrate private reasoning.",
	"Keep process_update to at most five outcome-oriented steps and mark completed only after requested verification is actually run.",
];

function cloneSnapshot(snapshot: ProcessSnapshot): ProcessSnapshot {
	return createPersistedState(snapshot, "compact").snapshot!;
}

function isUnfinished(snapshot: ProcessSnapshot | undefined): snapshot is ProcessSnapshot {
	return Boolean(snapshot && snapshot.status !== "completed");
}

function processSummary(state: PersistedProcessState): string {
	const snapshot = state.snapshot;
	if (!snapshot) return `Process view: ${state.viewMode} · no active task`;
	const done = snapshot.steps.filter((step) => step.status === "done").length;
	return `Process view: ${state.viewMode} · ${snapshot.status} ${done}/${snapshot.steps.length} · ${snapshot.title}`;
}

function hiddenThinkingLabel(): string {
	let binding = "";
	try {
		binding = keyText("app.thinking.toggle");
	} catch {}
	return binding ? `Reasoning hidden · ${binding} to inspect` : "Reasoning hidden · thinking toggle to inspect";
}

export default function processView(pi: ExtensionAPI) {
	let state: PersistedProcessState = createPersistedState(undefined, "compact");
	let control: RuntimeControlState = { requestStarted: false };
	const activity = new ActivityTracker();
	let widgetMounted = false;
	let requestWidgetRender: (() => void) | undefined;
	let uiFailureNotified = false;
	let corruptStateNotified = false;

	const renderState = (): ProcessRenderState => ({
		viewMode: state.viewMode,
		...(state.snapshot ? { snapshot: state.snapshot } : {}),
		activity: activity.getSnapshot(),
	});

	const shouldShowWidget = (): boolean => {
		if (state.viewMode === "off") return false;
		if (state.snapshot) {
			return state.snapshot.status !== "completed"
				|| control.requestStarted
				|| activity.getSnapshot().stage !== "settled";
		}
		return activity.getSnapshot().stage !== "settled";
	};

	const notifyUiFailure = (ctx: ExtensionContext, error: unknown) => {
		if (uiFailureNotified) return;
		uiFailureNotified = true;
		const message = error instanceof Error ? error.message : String(error);
		try {
			ctx.ui.notify(`Process View UI unavailable: ${message}`, "warning");
		} catch {}
	};

	const refreshWidget = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		try {
			if (!shouldShowWidget()) {
				if (widgetMounted) ctx.ui.setWidget(PROCESS_WIDGET_KEY, undefined);
				widgetMounted = false;
				requestWidgetRender = undefined;
				return;
			}
			if (!widgetMounted) {
				ctx.ui.setWidget(PROCESS_WIDGET_KEY, (tui, theme) => {
					const render = () => tui.requestRender();
					requestWidgetRender = render;
					const widget = new ProcessWidget(renderState, theme);
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
		} catch (error) {
			notifyUiFailure(ctx, error);
		}
	};

	const appendState = (next: PersistedProcessState) => {
		pi.appendEntry<PersistedProcessState>(PROCESS_ENTRY_TYPE, next);
		state = next;
	};

	const appendSystemState = (next: PersistedProcessState, ctx: ExtensionContext): boolean => {
		try {
			appendState(next);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Process state could not be saved: ${message}`, "error");
			return false;
		}
	};

	const restore = (ctx: ExtensionContext) => {
		const restored = restoreProcessState(ctx.sessionManager.getBranch());
		state = restored.state;
		control = { requestStarted: false };
		activity.reset();
		uiFailureNotified = false;
		if (restored.corrupted) {
			try {
				pi.appendEntry<PersistedProcessState>(PROCESS_ENTRY_TYPE, state);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Cleared Process state could not be saved: ${message}`, "error");
			}
			if (!corruptStateNotified) {
				corruptStateNotified = true;
				ctx.ui.notify("Process state was invalid and has been cleared", "warning");
			}
		}
		refreshWidget(ctx);
	};

	pi.registerTool({
		name: "process_update",
		label: "Process update",
		description: "Publish a concise structured snapshot of user-visible progress for the current task.",
		promptSnippet: "Publish concise user-visible task progress for non-trivial work",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ProcessUpdateParams,
		executionMode: "sequential",
		renderShell: "self",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = normalizeProcessUpdate(params, state.snapshot);
			const next = createPersistedState(snapshot, state.viewMode);
			appendState(next);
			control.requestStarted = true;
			refreshWidget(ctx);
			const done = snapshot.steps.filter((step) => step.status === "done").length;
			return {
				content: [{ type: "text", text: `Process state updated: ${done}/${snapshot.steps.length} ${snapshot.status}` }],
				details: snapshot,
			};
		},

		renderCall() {
			return new Container();
		},

		renderResult(result, { expanded }, theme, context) {
			return renderToolResult(result, expanded, context.isError, theme);
		},
	});

	pi.registerCommand("process", {
		description: "Show or change the Process View: compact | full | off | clear",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action) {
				ctx.ui.notify(processSummary(state), "info");
				return;
			}
			if (action === "clear") {
				const next = createTombstone(state.viewMode);
				try {
					appendState(next);
					control.pendingContextReminder = undefined;
					activity.reset();
					refreshWidget(ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Process state could not be cleared: ${message}`, "error");
				}
				return;
			}
			if (action === "compact" || action === "full" || action === "off") {
				const mode = action as ProcessViewMode;
				const next = state.snapshot
					? createPersistedState(state.snapshot, mode)
					: state.cleared
						? createTombstone(mode)
						: createPersistedState(undefined, mode);
				try {
					appendState(next);
					refreshWidget(ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Process mode could not be saved: ${message}`, "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /process [compact|full|off|clear]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		if (ctx.mode === "tui") {
			try {
				ctx.ui.setHiddenThinkingLabel(hiddenThinkingLabel());
			} catch (error) {
				notifyUiFailure(ctx, error);
			}
		}
	});

	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	pi.on("before_agent_start", async (_event, ctx) => {
		control.requestStarted = true;
		control.pendingStopReason = undefined;
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
					customType: PROCESS_CONTEXT_TYPE,
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

	pi.on("tool_execution_start", async (event, ctx) => {
		activity.startTool(event.toolCallId, event.toolName, event.args, ctx.cwd);
		refreshWidget(ctx);
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
		if (snapshot && control.pendingStopReason && snapshot.status !== "completed") {
			appendSystemState(
				createPersistedState(interruptSnapshot(snapshot, control.pendingStopReason), state.viewMode),
				ctx,
			);
		} else if (snapshot?.status === "running") {
			appendSystemState(createPersistedState(settleSnapshot(snapshot), state.viewMode), ctx);
		}
		control.pendingStopReason = undefined;
		control.requestStarted = false;
		const finalStatus = state.snapshot?.status;
		activity.settle(finalStatus === "waiting" || finalStatus === "blocked" || finalStatus === "interrupted");
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode === "tui") {
			try {
				if (widgetMounted) ctx.ui.setWidget(PROCESS_WIDGET_KEY, undefined);
				ctx.ui.setHiddenThinkingLabel();
			} catch {}
		}
		widgetMounted = false;
		requestWidgetRender = undefined;
		activity.reset();
		control = { requestStarted: false };
	});
}
