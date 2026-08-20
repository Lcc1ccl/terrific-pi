import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	cloneStatuslineConfig,
	DEFAULT_CONFIG,
	enabledWidgets,
	hasWidget,
	loadStatuslineConfigResult,
	resolveRuntimeConfigPath,
	saveStatuslineConfig,
	WIDGET_IDS,
} from "../lib/config.ts";
import {
	formatConfigSummary,
	runStatuslineConfigurator,
	type MutationResult,
} from "../lib/configure.ts";
import { selectMenu } from "../lib/select-menu.ts";
import { AgentDurationTracker } from "../lib/duration.ts";
import { QuotaMonitor } from "../lib/quota.ts";
import { formatRunNotification } from "../lib/format.ts";
import { readRuntimeInfo, type RuntimeInfo } from "../lib/runtime-info.ts";
import { TurnTelemetryTracker, type TurnPerformanceView } from "../lib/telemetry.ts";
import { readWorktreeInfo, type WorktreeInfo } from "../lib/worktree.ts";
import {
	renderEditorStatus,
	renderStatusLine,
} from "../lib/render.ts";
import { WidgetsSetupComponent } from "../lib/widgets-setup.ts";
import { RUN_METRIC_WIDGET_IDS } from "../lib/types.ts";
import type {
	BranchChangeStats,
	EnvironmentCounts,
	RunState,
	StatuslineConfig,
	StatusSnapshot,
	ToolActivity,
} from "../lib/types.ts";
import { aggregateSessionUsage } from "../lib/usage.ts";
import {
	buildWidgetSegments,
	FAST_STATUS_KEY,
	joinExtensionProgress,
	MODE_STATUS_KEY,
	resolveRunState,
	runStateForAssistantEvent,
	sanitizeStatus,
	shouldTrackToolActivity,
} from "../lib/widgets.ts";

function safeContextPercent(tokens: number, contextWindow: number, maxOutputTokens: number): number | undefined {
	if (![tokens, contextWindow, maxOutputTokens].every(Number.isFinite)) return undefined;
	const safeInputLimit = contextWindow - Math.max(0, maxOutputTokens) - 16_384;
	return safeInputLimit > 0 ? tokens / safeInputLimit * 100 : undefined;
}

function parseNumstat(output: string): BranchChangeStats {
	let additions = 0;
	let deletions = 0;

	for (const line of output.split("\n")) {
		const [added, deleted] = line.split("\t", 3);
		additions += Number.parseInt(added ?? "", 10) || 0;
		deletions += Number.parseInt(deleted ?? "", 10) || 0;
	}

	return { additions, deletions };
}

const EDITOR_STATUS_EVENT = "terrific-pi:statusline:editor-v2";

type EditorStatusSource = {
	render(line: "line0" | "line1", width: number): string;
};

type EditorStatusRequest = {
	version: 2;
	active: boolean;
	attach?: (source: EditorStatusSource) => void;
	ownsEditor?: () => boolean;
};

function asEditorStatusRequest(value: unknown): EditorStatusRequest | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const request = value as Partial<EditorStatusRequest>;
	if (request.version !== 2 || typeof request.active !== "boolean") return undefined;
	if (request.active && (typeof request.attach !== "function" || typeof request.ownsEditor !== "function")) return undefined;
	return request as EditorStatusRequest;
}

function displayKey(key: string): string {
	return ({ up: "Up", down: "Down", enter: "Enter", escape: "Esc" }[key] ?? key.replace(/\b[a-z]/g, (char) => char.toUpperCase()));
}

function emptyToolActivity(): ToolActivity {
	return { active: 0, success: 0, error: 0 };
}

type QuotaContext = {
	model?: { id?: string; name?: string; provider?: string; api?: string; baseUrl?: string };
	modelRegistry: {
		isUsingOAuth(model: unknown): boolean;
		getRegisteredProviderConfig?(providerName: string): unknown;
		getApiKeyAndHeaders(model: unknown): Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string> }
			| { ok: false; error: string }
		>;
	};
};

type UsageContext = {
	sessionManager: {
		getBranch(): Parameters<typeof aggregateSessionUsage>[0];
	};
};

export default function statusline(pi: ExtensionAPI) {
	let runState: RunState = "Ready";
	let branchChanges: BranchChangeStats | undefined;
	let gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let projectRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let durationTickTimer: ReturnType<typeof setInterval> | undefined;
	let renderRequest: (() => void) | undefined;
	let lifecycleGeneration = 0;
	let gitRequestGeneration = 0;
	let projectRequestGeneration = 0;
	let config: StatuslineConfig = cloneStatuslineConfig(DEFAULT_CONFIG);
	let configPath = resolveRuntimeConfigPath();
	let configLoadError: string | undefined;
	let quotaContext: QuotaContext | undefined;
	let currentCwd: string | undefined;
	let usage = aggregateSessionUsage([]);
	const activeTools = new Set<string>();
	const toolCallNames = new Map<string, string>();
	const toolStats: Record<string, ToolActivity> = {};
	let environment: EnvironmentCounts | undefined;
	let worktree: WorktreeInfo | undefined;
	let runtime: RuntimeInfo | undefined;
	let performanceView: TurnPerformanceView | undefined;
	let editorStatusActive = false;
	let editorStatusSource: EditorStatusSource | undefined;
	let editorStatusAttach: ((source: EditorStatusSource) => void) | undefined;
	let editorStatusOwns: (() => boolean) | undefined;
	const defaultBranchCache = new Map<string, string | null>();
	const durationTracker = new AgentDurationTracker();
	const telemetryTracker = new TurnTelemetryTracker();
	const quotaMonitor = new QuotaMonitor({
		onChange: () => requestRender(),
	});

	const requestRender = () => renderRequest?.();
	const attachEditorStatus = () => {
		if (!editorStatusAttach || !editorStatusSource) return;
		try {
			editorStatusAttach(editorStatusSource);
			editorStatusActive = true;
			requestRender();
		} catch {
			editorStatusAttach = undefined;
			editorStatusOwns = undefined;
			editorStatusActive = false;
		}
	};
	const ownsEditorStatus = () => {
		if (!editorStatusActive || !editorStatusOwns) return false;
		try {
			return editorStatusOwns();
		} catch {
			return false;
		}
	};
	const unsubscribeEditorStatus = pi.events.on(EDITOR_STATUS_EVENT, (value) => {
		const request = asEditorStatusRequest(value);
		if (!request) return;
		if (!request.active) {
			editorStatusAttach = undefined;
			editorStatusOwns = undefined;
			editorStatusActive = false;
			requestRender();
			return;
		}
		if (!request.attach || !request.ownsEditor) return;
		editorStatusAttach = request.attach;
		editorStatusOwns = request.ownsEditor;
		attachEditorStatus();
	});

	const cloneConfig = cloneStatuslineConfig;
	const runMetricsEnabled = () => RUN_METRIC_WIDGET_IDS.some((id) => hasWidget(config, id));
	const runTrackingEnabled = () => Boolean(config.runNotification) || runMetricsEnabled();

	const syncQuota = async (ctx: QuotaContext) => {
		const enabled = hasWidget(config, "quota");
		await quotaMonitor.sync(ctx.model, ctx.modelRegistry as never, enabled);
	};

	const requestQuotaSync = () => {
		if (quotaContext) void syncQuota(quotaContext);
	};

	const reloadConfig = (): MutationResult<StatuslineConfig> => {
		configPath = resolveRuntimeConfigPath();
		const loaded = loadStatuslineConfigResult(configPath);
		if (!loaded.ok) {
			configLoadError = loaded.error;
			return loaded;
		}
		config = loaded.value;
		configLoadError = undefined;
		telemetryTracker.reset("reload");
		performanceView = undefined;
		invalidateProjectInfo();
		requestRender();
		requestQuotaSync();
		return { ok: true, value: cloneConfig(config) };
	};

	const refreshUsage = (ctx: UsageContext) => {
		const branch = ctx.sessionManager.getBranch();
		usage = aggregateSessionUsage(branch);
		requestRender();
	};

	const applyConfig = (next: StatuslineConfig, overwriteInvalid = false): MutationResult<void> => {
		if (configLoadError && !overwriteInvalid) {
			return {
				ok: false,
				error: `${configLoadError}. Fix the file and reload, or use Reset to defaults.`,
			};
		}
		const previous = cloneConfig(config);
		const candidate = cloneConfig(next);
		try {
			saveStatuslineConfig(configPath, candidate);
			config = candidate;
			configLoadError = undefined;
			telemetryTracker.reset("reload");
			performanceView = undefined;
			invalidateProjectInfo();
			requestRender();
			requestQuotaSync();
			return { ok: true, value: undefined };
		} catch (error) {
			config = previous;
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `Failed to save config: ${message}` };
		}
	};

	const resetConfig = (): MutationResult<void> =>
		applyConfig(cloneConfig(DEFAULT_CONFIG), true);

	const git = async (cwd: string, args: string[]): Promise<string | undefined> => {
		const result = await pi.exec("git", ["--no-optional-locks", ...args], { cwd, timeout: 2_000 });
		return result.code === 0 ? result.stdout.trim() : undefined;
	};

	const gitRefExists = async (cwd: string, reference: string): Promise<boolean> =>
		(await git(cwd, ["rev-parse", "--verify", "--quiet", reference])) !== undefined;

	const resolveDefaultBranch = async (cwd: string): Promise<string | undefined> => {
		const cached = defaultBranchCache.get(cwd);
		if (cached !== undefined) return cached ?? undefined;

		const remotes = (await git(cwd, ["remote"]))?.split("\n").filter(Boolean) ?? [];
		const originIndex = remotes.indexOf("origin");
		if (originIndex > 0) remotes.unshift(...remotes.splice(originIndex, 1));

		for (const remote of remotes) {
			const remoteHead = `refs/remotes/${remote}/HEAD`;
			const symbolicRef = await git(cwd, ["symbolic-ref", "--quiet", remoteHead]);
			if (symbolicRef && await gitRefExists(cwd, symbolicRef)) {
				defaultBranchCache.set(cwd, symbolicRef);
				return symbolicRef;
			}

			for (const branch of ["main", "master"]) {
				const remoteRef = `refs/remotes/${remote}/${branch}`;
				if (await gitRefExists(cwd, remoteRef)) {
					defaultBranchCache.set(cwd, remoteRef);
					return remoteRef;
				}
			}
		}

		for (const candidate of ["refs/heads/main", "refs/heads/master"]) {
			if (await gitRefExists(cwd, candidate)) {
				defaultBranchCache.set(cwd, candidate);
				return candidate;
			}
		}

		defaultBranchCache.set(cwd, null);
		return undefined;
	};

	const refreshBranchChanges = async (cwd: string, lifecycle: number, request: number) => {
		if (!hasWidget(config, "branchDiff")) return;
		const defaultBranch = await resolveDefaultBranch(cwd);
		const mergeBase = defaultBranch ? await git(cwd, ["merge-base", "HEAD", defaultBranch]) : undefined;
		const numstat = mergeBase ? await git(cwd, ["diff", "--numstat", `${mergeBase}..HEAD`]) : undefined;
		if (lifecycle !== lifecycleGeneration || request !== gitRequestGeneration) return;
		branchChanges = numstat === undefined ? undefined : parseNumstat(numstat);
		requestRender();
	};

	const scheduleGitRefresh = (cwd: string, delay = 120) => {
		if (!hasWidget(config, "branchDiff")) {
			branchChanges = undefined;
			if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
			gitRefreshTimer = undefined;
			return;
		}
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		const lifecycle = lifecycleGeneration;
		const request = ++gitRequestGeneration;
		gitRefreshTimer = setTimeout(() => {
			gitRefreshTimer = undefined;
			void refreshBranchChanges(cwd, lifecycle, request).catch(() => {
				if (lifecycle !== lifecycleGeneration || request !== gitRequestGeneration) return;
				branchChanges = undefined;
				requestRender();
			});
		}, delay);
	};

	const refreshProjectInfo = async (cwd: string, lifecycle: number, request: number) => {
		const [nextWorktree, nextRuntime] = await Promise.all([
			hasWidget(config, "worktree") ? readWorktreeInfo(pi.exec.bind(pi), cwd) : undefined,
			hasWidget(config, "runtime") ? readRuntimeInfo(cwd, pi.exec.bind(pi)) : undefined,
		]);
		if (lifecycle !== lifecycleGeneration || request !== projectRequestGeneration) return;
		worktree = nextWorktree;
		runtime = nextRuntime;
		requestRender();
	};

	const scheduleProjectRefresh = (cwd: string, delay = 120) => {
		if (!hasWidget(config, "worktree") && !hasWidget(config, "runtime")) {
			worktree = undefined;
			runtime = undefined;
			if (projectRefreshTimer) clearTimeout(projectRefreshTimer);
			projectRefreshTimer = undefined;
			return;
		}
		if (projectRefreshTimer) clearTimeout(projectRefreshTimer);
		const lifecycle = lifecycleGeneration;
		const request = ++projectRequestGeneration;
		projectRefreshTimer = setTimeout(() => {
			projectRefreshTimer = undefined;
			void refreshProjectInfo(cwd, lifecycle, request).catch(() => {
				if (lifecycle !== lifecycleGeneration || request !== projectRequestGeneration) return;
				worktree = undefined;
				runtime = undefined;
				requestRender();
			});
		}, delay);
	};

	const invalidateProjectInfo = () => {
		projectRequestGeneration += 1;
		if (projectRefreshTimer) clearTimeout(projectRefreshTimer);
		projectRefreshTimer = undefined;
		worktree = undefined;
		runtime = undefined;
		if (currentCwd) scheduleProjectRefresh(currentCwd, 0);
	};

	const setRunState = (state: RunState) => {
		runState = state;
		requestRender();
	};

	const stopDurationTick = () => {
		if (durationTickTimer) {
			clearInterval(durationTickTimer);
			durationTickTimer = undefined;
		}
	};

	const startDurationTick = () => {
		if (durationTickTimer) return;
		durationTickTimer = setInterval(() => {
			if (!durationTracker.isRunning()) {
				stopDurationTick();
				return;
			}
			requestRender();
		}, 250);
	};

	const ensureTool = (name: string): ToolActivity => {
		if (!toolStats[name]) toolStats[name] = emptyToolActivity();
		return toolStats[name]!;
	};

	const clearActiveTools = () => {
		for (const name of Object.keys(toolStats)) {
			toolStats[name]!.active = 0;
		}
		activeTools.clear();
		toolCallNames.clear();
	};

	const resetToolActivity = () => {
		for (const name of Object.keys(toolStats)) {
			delete toolStats[name];
		}
		clearActiveTools();
	};

	pi.registerCommand("statusline", {
		description: "Open the statusline manager or reload its config",
		getArgumentCompletions(prefix) {
			const query = prefix.trim().toLowerCase();
			return ["reload"]
				.filter((value) => value.startsWith(query))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			quotaContext = ctx;
			const action = args.trim().toLowerCase();
			if (action === "reload") {
				const reloaded = reloadConfig();
				if (!reloaded.ok) {
					ctx.ui.notify(reloaded.error, "error");
					return;
				}
				ctx.ui.notify(`Statusline config reloaded (${enabledWidgets(reloaded.value).join(", ")})`, "info");
				return;
			}

			if (action) {
				ctx.ui.notify("Usage: /statusline [reload]", "warning");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					[
						formatConfigSummary(config, configPath),
						"",
						"Interactive config requires TUI mode.",
						"Edit the config file or run /statusline in TUI.",
						"Env override: PI_STATUSLINE_CONFIG=/path/to.json",
					].join("\n"),
					"info",
				);
				return;
			}

			const loaded = reloadConfig();
			if (!loaded.ok) ctx.ui.notify(loaded.error, "error");
			await runStatuslineConfigurator(
				{
					getConfig: () => cloneConfig(config),
					getConfigPath: () => configPath,
					applyConfig,
					reloadConfig,
					resetConfig,
					ui: {
						selectMain: (title, items) => selectMenu(ctx, title, items, { cancelAction: "cancel" }),
						select: (title, items) => selectMenu(ctx, title, items, { cancelAction: "back" }),
						input: (title, initialValue) =>
							ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
								const key = (binding: "tui.input.submit" | "tui.select.cancel", fallback: string) =>
									displayKey(keybindings.getKeys?.(binding)[0] ?? fallback);
								const container = new Container();
								container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
								container.addChild(new Text(theme.fg("accent", theme.bold(title))));
								const input = new Input();
								input.setValue(initialValue);
								input.focused = true;
								container.addChild(input);
								container.addChild(new Text(theme.fg("dim", `${key("tui.input.submit", "enter")} submit · ${key("tui.select.cancel", "escape")} cancel`), 1, 0));
								container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
								return {
									render: (width) => container.render(width),
									invalidate: () => container.invalidate(),
									handleInput: (data) => {
										if (keybindings.matches(data, "tui.input.submit") || data === "\n" || data === "\r") done(input.getValue());
										else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
										else input.handleInput(data);
										tui.requestRender();
									},
								};
							}),
						confirm: (title, message) => ctx.ui.confirm(title, message),
						editWidgets: (title, allWidgets, lines, widgetOrder, onChange, onReject) =>
							ctx.ui.custom<typeof lines | undefined>((tui, theme, keybindings, done) =>
								new WidgetsSetupComponent({
									title,
									allWidgets,
									lines,
									widgetOrder,
									theme,
									previewConfig: cloneConfig(config),
									keybindings,
									onChange,
									onReject,
									done,
									requestRender: () => tui.requestRender(),
								}),
							),
						notify: (message, level) => ctx.ui.notify(message, level),
					},
				},
				WIDGET_IDS,
			);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;

		lifecycleGeneration += 1;
		gitRequestGeneration += 1;
		projectRequestGeneration += 1;
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		if (projectRefreshTimer) clearTimeout(projectRefreshTimer);
		gitRefreshTimer = undefined;
		projectRefreshTimer = undefined;
		renderRequest = undefined;
		quotaContext = ctx;
		currentCwd = ctx.cwd;
		quotaMonitor.clear();
		runState = "Ready";
		branchChanges = undefined;
		environment = undefined;
		worktree = undefined;
		runtime = undefined;
		performanceView = undefined;
		editorStatusActive = false;
		editorStatusSource = undefined;
		telemetryTracker.reset(event.reason === "reload" ? "reload" : "session");
		clearActiveTools();
		for (const name of Object.keys(toolStats)) delete toolStats[name];
		durationTracker.reset();
		stopDurationTick();
		refreshUsage(ctx);
		const loaded = reloadConfig();
		if (!loaded.ok) {
			ctx.ui.notify(loaded.error, "error");
			requestQuotaSync();
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const localRenderRequest = () => tui.requestRender();
			renderRequest = localRenderRequest;
			const unsubscribeBranch = footerData.onBranchChange(() => {
				scheduleGitRefresh(ctx.cwd, 0);
				scheduleProjectRefresh(ctx.cwd, 0);
				tui.requestRender();
			});
			const currentSnapshot = (): StatusSnapshot => {
				const context = ctx.getContextUsage();
				const safePercent = context?.tokens !== null && context?.tokens !== undefined && typeof ctx.model?.maxTokens === "number"
					? safeContextPercent(context.tokens, context.contextWindow, ctx.model.maxTokens)
					: undefined;
				const thinking = ctx.model?.reasoning ? pi.getThinkingLevel() : "off";
				const extensionStatuses = footerData.getExtensionStatuses();
				const modeStatus = extensionStatuses.get(MODE_STATUS_KEY);
				const fastStatus = extensionStatuses.get(FAST_STATUS_KEY);
				return {
					cwd: ctx.cwd,
					sessionName: ctx.sessionManager.getSessionName(),
					modelId: ctx.model?.id ?? "no-model",
					thinkingLevel: thinking,
					hasReasoning: Boolean(ctx.model?.reasoning),
					mode: modeStatus ? sanitizeStatus(modeStatus) || undefined : undefined,
					fast: fastStatus ? sanitizeStatus(fastStatus) || undefined : undefined,
					tokens: usage.tokens,
					cost: usage.cost,
					context: context
						? {
							tokens: context.tokens,
							contextWindow: context.contextWindow,
							percent: context.percent,
							...(safePercent !== undefined ? { safePercent } : {}),
						}
						: undefined,
					branch: footerData.getGitBranch(),
					branchDiff: branchChanges,
					progress: joinExtensionProgress(extensionStatuses),
					duration: durationTracker.snapshot(),
					runState: resolveRunState(runState, extensionStatuses),
					quota: hasWidget(config, "quota") ? quotaMonitor.getSnapshot() : undefined,
					quotaStatus: hasWidget(config, "quota") ? quotaMonitor.getStatus() : undefined,
					environment: hasWidget(config, "environment") ? environment : undefined,
					toolActivity: hasWidget(config, "toolActivity") && Object.keys(toolStats).length > 0
						? toolStats
						: undefined,
					worktree: hasWidget(config, "worktree") ? worktree : undefined,
					runtime: hasWidget(config, "runtime") ? runtime : undefined,
					performance: runMetricsEnabled() ? performanceView : undefined,
				};
			};
			const source: EditorStatusSource = {
				render: (line, width) => renderEditorStatus(
					buildWidgetSegments(currentSnapshot(), config),
					config,
					theme,
					width,
					truncateToWidth,
					visibleWidth,
					line,
				),
			};
			editorStatusSource = source;
			attachEditorStatus();

			return {
				dispose() {
					unsubscribeBranch();
					if (renderRequest === localRenderRequest) renderRequest = undefined;
					if (editorStatusSource === source) {
						editorStatusSource = undefined;
						editorStatusActive = false;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					const segments = buildWidgetSegments(currentSnapshot(), config);
					return renderStatusLine(
						segments,
						config,
						theme,
						width,
						truncateToWidth,
						visibleWidth,
						ownsEditorStatus() ? "line2" : "line0",
					);
				},
			};
		});

		scheduleGitRefresh(ctx.cwd, 0);
		scheduleProjectRefresh(ctx.cwd, 0);
	});

	pi.on("before_agent_start", async (event) => {
		const options = event.systemPromptOptions;
		if (!options) return;
		environment = {
			contextFiles: options.contextFiles?.length ?? 0,
			skills: options.skills?.length ?? 0,
			tools: options.selectedTools?.length ?? 0,
		};
		requestRender();
	});

	pi.on("agent_start", async (event) => {
		resetToolActivity();
		performanceView = undefined;
		if (runTrackingEnabled()) telemetryTracker.handle(event);
		durationTracker.startRound();
		startDurationTick();
		setRunState("Thinking");
	});
	pi.on("turn_start", async (event) => {
		if (runTrackingEnabled()) telemetryTracker.handle(event);
		setRunState("Thinking");
	});
	pi.on("message_start", async (event) => {
		if (runTrackingEnabled()) telemetryTracker.handle(event);
	});
	pi.on("message_end", async (event, ctx) => {
		if (runTrackingEnabled()) telemetryTracker.handle(event);
		if (event.message.role !== "assistant") return;
		refreshUsage(ctx);
	});
	pi.on("message_update", async (event) => {
		if (runTrackingEnabled()) telemetryTracker.handle(event);
		if (activeTools.size > 0) return;
		const state = runStateForAssistantEvent(event.assistantMessageEvent.type);
		if (state) setRunState(state);
	});
	pi.on("turn_end", async (event) => {
		if (runTrackingEnabled()) telemetryTracker.handle(event);
	});
	pi.on("agent_end", async (event) => {
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (lastAssistant?.stopReason === "aborted" || lastAssistant?.stopReason === "error") {
			telemetryTracker.reset("abort");
			performanceView = undefined;
			requestRender();
		}
	});
	pi.on("agent_settled", async (event, ctx) => {
		const settled = runTrackingEnabled() ? telemetryTracker.handle(event) : undefined;
		if (settled && runMetricsEnabled()) performanceView = settled;
		if (settled && config.runNotification && ctx.mode === "tui") {
			ctx.ui.notify(formatRunNotification(settled, config.iconMode).text, "info");
		}
		clearActiveTools();
		durationTracker.endRound();
		stopDurationTick();
		refreshUsage(ctx);
		setRunState("Ready");
		scheduleGitRefresh(ctx.cwd, 0);
		scheduleProjectRefresh(ctx.cwd, 0);
	});
	pi.on("tool_execution_start", async (event) => {
		if (!shouldTrackToolActivity(event.toolName)) return;
		activeTools.add(event.toolCallId);
		toolCallNames.set(event.toolCallId, event.toolName);
		const stats = ensureTool(event.toolName);
		stats.active += 1;
		setRunState("Waiting");
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (!shouldTrackToolActivity(event.toolName)) return;
		activeTools.delete(event.toolCallId);
		const name = toolCallNames.get(event.toolCallId) ?? event.toolName;
		toolCallNames.delete(event.toolCallId);
		const stats = ensureTool(name);
		stats.active = Math.max(0, stats.active - 1);
		if (event.isError) stats.error += 1;
		else stats.success += 1;
		setRunState(activeTools.size > 0 ? "Waiting" : "Thinking");
		scheduleGitRefresh(ctx.cwd);
		scheduleProjectRefresh(ctx.cwd);
	});
	pi.on("model_select", async (_event, ctx) => {
		quotaContext = ctx;
		quotaMonitor.clear();
		requestQuotaSync();
		requestRender();
	});
	pi.on("after_provider_response", async (event, ctx) => {
		if (!hasWidget(config, "quota")) return;
		quotaContext = ctx;
		quotaMonitor.noteProviderResponse(event.status, event.headers);
		requestQuotaSync();
	});
	pi.on("session_tree", async (_event, ctx) => {
		quotaContext = ctx;
		telemetryTracker.reset("tree");
		performanceView = undefined;
		resetToolActivity();
		refreshUsage(ctx);
		requestQuotaSync();
	});
	pi.on("thinking_level_select", async () => requestRender());
	pi.on("session_compact", async (_event, ctx) => {
		telemetryTracker.reset("compact");
		performanceView = undefined;
		refreshUsage(ctx);
	});
	pi.on("session_info_changed", async () => requestRender());
	pi.on("session_shutdown", async () => {
		lifecycleGeneration += 1;
		gitRequestGeneration += 1;
		projectRequestGeneration += 1;
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		if (projectRefreshTimer) clearTimeout(projectRefreshTimer);
		gitRefreshTimer = undefined;
		projectRefreshTimer = undefined;
		stopDurationTick();
		durationTracker.reset();
		telemetryTracker.reset("shutdown");
		performanceView = undefined;
		worktree = undefined;
		runtime = undefined;
		renderRequest = undefined;
		editorStatusActive = false;
		editorStatusSource = undefined;
		editorStatusAttach = undefined;
		editorStatusOwns = undefined;
		unsubscribeEditorStatus();
		clearActiveTools();
		quotaContext = undefined;
		currentCwd = undefined;
		quotaMonitor.dispose();
		usage = aggregateSessionUsage([]);
		environment = undefined;
	});
}
