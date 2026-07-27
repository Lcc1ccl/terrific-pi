import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	DEFAULT_CONFIG,
	loadStatuslineConfigResult,
	resolveEffectiveLayout,
	resolveEffectiveRenderConfig,
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
import { readAppearanceProfile } from "../lib/appearance-profile.ts";
import { AgentDurationTracker } from "../lib/duration.ts";
import { QuotaMonitor } from "../lib/quota.ts";
import { renderStatusLine, withTerrificStateSpinner } from "../lib/render.ts";
import { WidgetsSetupComponent } from "../lib/widgets-setup.ts";
import type {
	BranchChangeStats,
	EnvironmentCounts,
	RunState,
	StatuslineConfig,
	StatusSnapshot,
	ToolActivity,
} from "../lib/types.ts";
import { aggregateAuxiliaryUsage, aggregateSessionUsage, hasAuxUsage } from "../lib/usage.ts";
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

const AUXILIARY_USAGE_CHANGED_EVENT = "terrific-pi:auxiliary-usage:changed-v1";
const TERRIFIC_TICK_MS = 133;
const DEFAULT_TICK_MS = 250;
const FOOTER_OWNER_KEY = Symbol.for("terrific-pi.statusline.footer-owner.v1");
const ownerGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
const footerOwners = ownerGlobal[FOOTER_OWNER_KEY] instanceof WeakMap
	? ownerGlobal[FOOTER_OWNER_KEY] as WeakMap<object, symbol>
	: new WeakMap<object, symbol>();
if (ownerGlobal[FOOTER_OWNER_KEY] === undefined) {
	Object.defineProperty(ownerGlobal, FOOTER_OWNER_KEY, { value: footerOwners });
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
	let durationTickTimer: ReturnType<typeof setInterval> | undefined;
	let durationTickCadence: number | undefined;
	let durationTickGeneration = 0;
	let renderTick = 0;
	let renderRequest: (() => void) | undefined;
	let lifecycleGeneration = 0;
	let gitRequestGeneration = 0;
	let config: StatuslineConfig = { ...DEFAULT_CONFIG, widgets: [...DEFAULT_CONFIG.widgets] };
	let configPath = resolveRuntimeConfigPath();
	let configLoadError: string | undefined;
	let quotaContext: QuotaContext | undefined;
	let usageContext: UsageContext | undefined;
	let usage = aggregateSessionUsage([]);
	let auxiliaryUsage = aggregateAuxiliaryUsage([]);
	const activeTools = new Set<string>();
	const toolCallNames = new Map<string, string>();
	const toolStats: Record<string, ToolActivity> = {};
	let environment: EnvironmentCounts | undefined;
	let activeOwner: { ui: object & { setWorkingVisible(value: boolean): void }; token: symbol } | undefined;
	let profileActive = false;
	let syncPresentation = () => {};
	const defaultBranchCache = new Map<string, string | null>();
	const durationTracker = new AgentDurationTracker();
	const quotaMonitor = new QuotaMonitor({
		onChange: () => requestRender(),
	});

	const requestRender = () => renderRequest?.();

	const cloneConfig = (value: StatuslineConfig): StatuslineConfig => ({
		...value,
		widgets: [...value.widgets],
		...(value.widgetGroups ? { widgetGroups: { ...value.widgetGroups } } : {}),
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
		profileActive = readAppearanceProfile().active;
		const loaded = loadStatuslineConfigResult(configPath);
		if (!loaded.ok) {
			configLoadError = loaded.error;
			syncPresentation();
			requestRender();
			return loaded;
		}
		config = loaded.value;
		configLoadError = undefined;
		syncPresentation();
		requestRender();
		requestQuotaSync();
		return { ok: true, value: cloneConfig(config) };
	};

	const refreshUsage = (ctx: UsageContext) => {
		const branch = ctx.sessionManager.getBranch();
		usage = aggregateSessionUsage(branch);
		auxiliaryUsage = aggregateAuxiliaryUsage(branch);
		requestRender();
	};

	pi.events.on(AUXILIARY_USAGE_CHANGED_EVENT, () => {
		if (usageContext) refreshUsage(usageContext);
	});

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
			syncPresentation();
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
		durationTickGeneration += 1;
		if (durationTickTimer) {
			clearInterval(durationTickTimer);
			durationTickTimer = undefined;
		}
		durationTickCadence = undefined;
	};

	const effectiveLayout = () => resolveEffectiveLayout(config.layout, profileActive);

	const startDurationTick = () => {
		const cadence = effectiveLayout() === "terrific" ? TERRIFIC_TICK_MS : DEFAULT_TICK_MS;
		if (durationTickTimer && durationTickCadence === cadence) return;
		stopDurationTick();
		durationTickCadence = cadence;
		const generation = ++durationTickGeneration;
		durationTickTimer = setInterval(() => {
			if (generation !== durationTickGeneration) return;
			if (!durationTracker.isRunning()) {
				stopDurationTick();
				return;
			}
			if (cadence === TERRIFIC_TICK_MS) renderTick += 1;
			requestRender();
		}, cadence);
	};

	const restoreWorkingVisibility = (ui: object & { setWorkingVisible(value: boolean): void }, token: symbol) => {
		if (footerOwners.get(ui) !== token) return;
		footerOwners.delete(ui);
		ui.setWorkingVisible(true);
		if (activeOwner?.token === token) activeOwner = undefined;
	};

	syncPresentation = () => {
		const owner = activeOwner;
		if (owner && footerOwners.get(owner.ui) === owner.token) {
			owner.ui.setWorkingVisible(effectiveLayout() !== "terrific");
		}
		if (durationTracker.isRunning()) startDurationTick();
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
				ctx.ui.notify(`Statusline config reloaded (${reloaded.value.widgets.join(", ")})`, "info");
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
						editWidgets: (title, allWidgets, enabled, widgetGroups, onChange, onReject) =>
							ctx.ui.custom<typeof enabled | undefined>((tui, theme, keybindings, done) =>
								new WidgetsSetupComponent({
									title,
									allWidgets,
									enabled,
									widgetGroups,
									theme,
									previewConfig: cloneConfig(config),
									keybindings,
									onChange: (next, nextGroups) =>
										onChange(next as typeof enabled, nextGroups),
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
		usageContext = ctx;
		quotaMonitor.clear();
		runState = "Ready";
		branchChanges = undefined;
		environment = undefined;
		clearActiveTools();
		for (const name of Object.keys(toolStats)) delete toolStats[name];
		durationTracker.reset();
		renderTick = 0;
		stopDurationTick();
		refreshUsage(ctx);
		const loaded = reloadConfig();
		if (!loaded.ok) {
			ctx.ui.notify(loaded.error, "error");
			requestQuotaSync();
		}

		const owner = { ui: ctx.ui, token: Symbol("statusline-footer") };
		footerOwners.set(owner.ui, owner.token);
		activeOwner = owner;
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
					if (footerOwners.get(owner.ui) === owner.token) {
						stopDurationTick();
						durationTracker.reset();
						restoreWorkingVisibility(owner.ui, owner.token);
					}
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
						auxUsage: hasAuxUsage(auxiliaryUsage) ? auxiliaryUsage : undefined,
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
						runState: resolveRunState(runState, extensionStatuses),
						quota: config.widgets.includes("quota") ? quotaMonitor.getSnapshot() : undefined,
						quotaStatus: config.widgets.includes("quota") ? quotaMonitor.getStatus() : undefined,
						environment: config.widgets.includes("environment") ? environment : undefined,
						toolActivity: config.widgets.includes("toolActivity") && Object.keys(toolStats).length > 0
							? toolStats
							: undefined,
					};

					const effectiveConfig = resolveEffectiveRenderConfig(config, profileActive);
					const builtSegments = buildWidgetSegments(snapshot, effectiveConfig);
					const segments = effectiveConfig.layout === "terrific"
						? withTerrificStateSpinner(
							builtSegments,
							snapshot.runState,
							renderTick,
							process.env.TERM === "dumb",
						)
						: builtSegments;
					const terminalRows = (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows
						?? process.stdout.rows
						?? 24;
					const rendered = renderStatusLine(
						segments,
						effectiveConfig,
						theme,
						width,
						truncateToWidth,
						visibleWidth,
						terminalRows,
					);
					return Array.isArray(rendered) ? rendered : [rendered];
				},
			};
		});
		syncPresentation();

		scheduleGitRefresh(ctx.cwd, 0);
	});

	pi.on("before_agent_start", async (event) => {
		reloadConfig();
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
		renderTick = 0;
		durationTracker.startRound();
		startDurationTick();
		setRunState("Thinking");
	});
	pi.on("turn_start", async () => setRunState("Thinking"));
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
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
		renderTick = 0;
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
		usageContext = ctx;
		resetToolActivity();
		refreshUsage(ctx);
		requestQuotaSync();
	});
	pi.on("thinking_level_select", async () => requestRender());
	pi.on("session_compact", async (_event, ctx) => refreshUsage(ctx));
	pi.on("session_info_changed", async () => requestRender());
	pi.on("session_shutdown", async (_event, ctx) => {
		lifecycleGeneration += 1;
		gitRequestGeneration += 1;
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		gitRefreshTimer = undefined;
		stopDurationTick();
		renderTick = 0;
		durationTracker.reset();
		renderRequest = undefined;
		clearActiveTools();
		quotaContext = undefined;
		usageContext = undefined;
		quotaMonitor.dispose();
		usage = aggregateSessionUsage([]);
		auxiliaryUsage = aggregateAuxiliaryUsage([]);
		environment = undefined;
		const owner = activeOwner;
		if (owner && ctx.mode === "tui") restoreWorkingVisibility(owner.ui, owner.token);
	});
}
