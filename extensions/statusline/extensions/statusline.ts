import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	DEFAULT_CONFIG,
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
import { LlmDurationTracker } from "../lib/duration.ts";
import { QuotaMonitor } from "../lib/quota.ts";
import { renderStatusLine } from "../lib/render.ts";
import { WidgetsSetupComponent } from "../lib/widgets-setup.ts";
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
	runStateForAssistantEvent,
	sanitizeStatus,
	shouldTrackToolActivity,
} from "../lib/widgets.ts";

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
	let durationTickTimer: ReturnType<typeof setInterval> | undefined;
	let renderRequest: (() => void) | undefined;
	let lifecycleGeneration = 0;
	let gitRequestGeneration = 0;
	let config: StatuslineConfig = { ...DEFAULT_CONFIG, widgets: [...DEFAULT_CONFIG.widgets] };
	let configPath = resolveRuntimeConfigPath();
	let configLoadError: string | undefined;
	let quotaContext: QuotaContext | undefined;
	let usage = aggregateSessionUsage([]);
	const activeTools = new Set<string>();
	const toolCallNames = new Map<string, string>();
	const toolStats: Record<string, ToolActivity> = {};
	let environment: EnvironmentCounts | undefined;
	const defaultBranchCache = new Map<string, string | null>();
	const durationTracker = new LlmDurationTracker();
	const quotaMonitor = new QuotaMonitor({
		onChange: () => requestRender(),
	});

	const requestRender = () => renderRequest?.();

	const cloneConfig = (value: StatuslineConfig): StatuslineConfig => ({
		...value,
		widgets: [...value.widgets],
	});

	const syncQuota = async (ctx: QuotaContext) => {
		const enabled = config.widgets.includes("quota");
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
		requestRender();
		requestQuotaSync();
		return { ok: true, value: cloneConfig(config) };
	};

	const refreshUsage = (ctx: UsageContext) => {
		usage = aggregateSessionUsage(ctx.sessionManager.getBranch());
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
		const defaultBranch = await resolveDefaultBranch(cwd);
		const mergeBase = defaultBranch ? await git(cwd, ["merge-base", "HEAD", defaultBranch]) : undefined;
		const numstat = mergeBase ? await git(cwd, ["diff", "--numstat", `${mergeBase}..HEAD`]) : undefined;
		if (lifecycle !== lifecycleGeneration || request !== gitRequestGeneration) return;
		branchChanges = numstat === undefined ? undefined : parseNumstat(numstat);
		requestRender();
	};

	const scheduleGitRefresh = (cwd: string, delay = 120) => {
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
		description: "Interactively configure pi statusline (or reload)",
		handler: async (args, ctx) => {
			quotaContext = ctx;
			const action = args.trim().toLowerCase();
			if (action === "reload") {
				const reloaded = reloadConfig();
				if (!reloaded.ok) {
					ctx.ui.notify(reloaded.error, "error");
					return;
				}
				ctx.ui.notify(`Statusline config reloaded (${reloaded.value.widgets.join(", ")})`, "info");
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
						selectMain: (title, items) =>
							ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
								const container = new Container();
								container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
								container.addChild(new Text(theme.fg("accent", theme.bold(title))));

								const selectList = new SelectList(
									items.map((value) => ({ value, label: value })),
									items.length,
									{
										selectedPrefix: (text) => theme.fg("accent", text),
										selectedText: (text) => theme.fg("accent", text),
										description: (text) => theme.fg("muted", text),
										scrollInfo: (text) => theme.fg("dim", text),
										noMatch: (text) => theme.fg("warning", text),
									},
								);
								selectList.onSelect = (item) => done(item.value);
								selectList.onCancel = () => done(undefined);
								container.addChild(selectList);
								container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

								return {
									render: (width) => container.render(width),
									invalidate: () => container.invalidate(),
									handleInput: (data) => {
										selectList.handleInput(data);
										tui.requestRender();
									},
								};
							}),
						select: (title, items) => ctx.ui.select(title, items),
						input: (title, initialValue) =>
							ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
								const container = new Container();
								container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
								container.addChild(new Text(theme.fg("accent", theme.bold(title))));
								const input = new Input();
								input.setValue(initialValue);
								input.focused = true;
								input.onSubmit = done;
								input.onEscape = () => done(undefined);
								container.addChild(input);
								container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
								return {
									render: (width) => container.render(width),
									invalidate: () => container.invalidate(),
									handleInput: (data) => {
										input.handleInput(data);
										tui.requestRender();
									},
								};
							}),
						confirm: (title, message) => ctx.ui.confirm(title, message),
						editWidgets: (title, allWidgets, enabled, onChange, onReject) =>
							ctx.ui.custom<typeof enabled | undefined>((tui, theme, keybindings, done) =>
								new WidgetsSetupComponent({
									title,
									allWidgets,
									enabled,
									theme,
									previewConfig: cloneConfig(config),
									keybindings,
									onChange: (next) => onChange(next as typeof enabled),
									onReject,
									done: (next) => done(next as typeof enabled | undefined),
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

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		lifecycleGeneration += 1;
		gitRequestGeneration += 1;
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		gitRefreshTimer = undefined;
		renderRequest = undefined;
		quotaContext = ctx;
		quotaMonitor.clear();
		runState = "Ready";
		branchChanges = undefined;
		environment = undefined;
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
				tui.requestRender();
			});

			return {
				dispose() {
					unsubscribeBranch();
					if (renderRequest === localRenderRequest) renderRequest = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const context = ctx.getContextUsage();
					const thinking = ctx.model?.reasoning ? pi.getThinkingLevel() : "off";
					const extensionStatuses = footerData.getExtensionStatuses();
					const modeStatus = extensionStatuses.get(MODE_STATUS_KEY);
					const fastStatus = extensionStatuses.get(FAST_STATUS_KEY);
					const snapshot: StatusSnapshot = {
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
							}
							: undefined,
						branch: footerData.getGitBranch(),
						branchDiff: branchChanges,
						progress: joinExtensionProgress(extensionStatuses),
						duration: durationTracker.snapshot(),
						runState,
						quota: config.widgets.includes("quota") ? quotaMonitor.getSnapshot() : undefined,
						quotaStatus: config.widgets.includes("quota") ? quotaMonitor.getStatus() : undefined,
						environment: config.widgets.includes("environment") ? environment : undefined,
						toolActivity: config.widgets.includes("toolActivity") && Object.keys(toolStats).length > 0
							? toolStats
							: undefined,
					};

					const segments = buildWidgetSegments(snapshot, config);
					const rendered = renderStatusLine(
						segments,
						config,
						theme,
						width,
						truncateToWidth,
						visibleWidth,
					);
					return Array.isArray(rendered) ? rendered : [rendered];
				},
			};
		});

		scheduleGitRefresh(ctx.cwd, 0);
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

	pi.on("agent_start", async () => {
		resetToolActivity();
		durationTracker.startRound();
		stopDurationTick();
		setRunState("Thinking");
	});
	pi.on("turn_start", async () => setRunState("Thinking"));
	// Pure LLM wall time: assistant stream only (excludes tools + idle).
	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		durationTracker.startSegment();
		startDurationTick();
		requestRender();
	});
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		durationTracker.stopSegment();
		stopDurationTick();
		refreshUsage(ctx);
	});
	pi.on("message_update", async (event) => {
		if (activeTools.size > 0) return;
		const state = runStateForAssistantEvent(event.assistantMessageEvent.type);
		if (state) setRunState(state);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		clearActiveTools();
		durationTracker.endRound();
		stopDurationTick();
		refreshUsage(ctx);
		setRunState("Ready");
		scheduleGitRefresh(ctx.cwd, 0);
	});
	pi.on("tool_execution_start", async (event) => {
		if (!shouldTrackToolActivity(event.toolName)) return;
		activeTools.add(event.toolCallId);
		toolCallNames.set(event.toolCallId, event.toolName);
		const stats = ensureTool(event.toolName);
		stats.active += 1;
		setRunState("Working");
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
		setRunState(activeTools.size > 0 ? "Working" : "Thinking");
		scheduleGitRefresh(ctx.cwd);
	});
	pi.on("model_select", async (_event, ctx) => {
		quotaContext = ctx;
		quotaMonitor.clear();
		requestQuotaSync();
		requestRender();
	});
	pi.on("after_provider_response", async (event, ctx) => {
		if (!config.widgets.includes("quota")) return;
		quotaContext = ctx;
		quotaMonitor.noteProviderResponse(event.status, event.headers);
		requestQuotaSync();
	});
	pi.on("session_tree", async (_event, ctx) => {
		quotaContext = ctx;
		resetToolActivity();
		refreshUsage(ctx);
		requestQuotaSync();
	});
	pi.on("thinking_level_select", async () => requestRender());
	pi.on("session_compact", async (_event, ctx) => refreshUsage(ctx));
	pi.on("session_info_changed", async () => requestRender());
	pi.on("session_shutdown", async () => {
		lifecycleGeneration += 1;
		gitRequestGeneration += 1;
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		gitRefreshTimer = undefined;
		stopDurationTick();
		durationTracker.reset();
		renderRequest = undefined;
		clearActiveTools();
		quotaContext = undefined;
		quotaMonitor.dispose();
		usage = aggregateSessionUsage([]);
		environment = undefined;
	});
}
