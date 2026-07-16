import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import {
	DEFAULT_CONFIG,
	loadStatuslineConfig,
	resolveRuntimeConfigPath,
	saveStatuslineConfig,
	WIDGET_IDS,
} from "../lib/config.ts";
import {
	formatConfigSummary,
	runStatuslineConfigurator,
	type MutationResult,
} from "../lib/configure.ts";
import { renderStatusLine, selectPalette } from "../lib/render.ts";
import { WidgetsSetupComponent } from "../lib/widgets-setup.ts";
import type { BranchChangeStats, RunState, StatuslineConfig, StatusSnapshot } from "../lib/types.ts";
import { aggregateSessionUsage } from "../lib/usage.ts";
import { buildWidgetSegments, joinExtensionProgress } from "../lib/widgets.ts";

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

export default function statusline(pi: ExtensionAPI) {
	let runState: RunState = "Ready";
	let branchChanges: BranchChangeStats | undefined;
	let gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let renderRequest: (() => void) | undefined;
	let config: StatuslineConfig = { ...DEFAULT_CONFIG, widgets: [...DEFAULT_CONFIG.widgets] };
	let configPath = resolveRuntimeConfigPath();
	const activeTools = new Set<string>();
	const defaultBranchCache = new Map<string, string | null>();

	const requestRender = () => renderRequest?.();

	const reloadConfig = () => {
		configPath = resolveRuntimeConfigPath();
		config = loadStatuslineConfig(configPath);
		requestRender();
	};

	const cloneConfig = (value: StatuslineConfig): StatuslineConfig => ({
		...value,
		widgets: [...value.widgets],
	});

	const applyConfig = (next: StatuslineConfig): MutationResult<void> => {
		const previous = cloneConfig(config);
		const candidate = cloneConfig(next);
		try {
			saveStatuslineConfig(configPath, candidate);
			config = candidate;
			requestRender();
			return { ok: true, value: undefined };
		} catch (error) {
			config = previous;
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `Failed to save config: ${message}` };
		}
	};

	const resetConfig = (): MutationResult<void> =>
		applyConfig(cloneConfig(DEFAULT_CONFIG));

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

			const remoteInfo = await git(cwd, ["remote", "show", remote]);
			const headName = remoteInfo
				?.split("\n")
				.map((line) => line.trim())
				.find((line) => line.startsWith("HEAD branch:"))
				?.slice("HEAD branch:".length)
				.trim();
			const remoteRef = headName ? `refs/remotes/${remote}/${headName}` : undefined;
			if (remoteRef && await gitRefExists(cwd, remoteRef)) {
				defaultBranchCache.set(cwd, remoteRef);
				return remoteRef;
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

	const refreshBranchChanges = async (cwd: string) => {
		const defaultBranch = await resolveDefaultBranch(cwd);
		const mergeBase = defaultBranch ? await git(cwd, ["merge-base", "HEAD", defaultBranch]) : undefined;
		const numstat = mergeBase ? await git(cwd, ["diff", "--numstat", `${mergeBase}..HEAD`]) : undefined;
		branchChanges = numstat === undefined ? undefined : parseNumstat(numstat);
		requestRender();
	};

	const scheduleGitRefresh = (cwd: string, delay = 120) => {
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		gitRefreshTimer = setTimeout(() => {
			gitRefreshTimer = undefined;
			void refreshBranchChanges(cwd).catch(() => {
				branchChanges = undefined;
				requestRender();
			});
		}, delay);
	};

	const setRunState = (state: RunState) => {
		runState = state;
		requestRender();
	};

	pi.registerCommand("statusline", {
		description: "Interactively configure pi statusline (or reload)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "reload") {
				reloadConfig();
				ctx.ui.notify(`Statusline config reloaded (${config.widgets.join(", ")})`, "info");
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

			reloadConfig();
			await runStatuslineConfigurator(
				{
					getConfig: () => cloneConfig(config),
					getConfigPath: () => configPath,
					applyConfig,
					reloadConfig: () => {
						try {
							reloadConfig();
							return { ok: true, value: cloneConfig(config) };
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							return { ok: false, error: `Failed to reload config: ${message}` };
						}
					},
					resetConfig,
					ui: {
						select: (title, items) => ctx.ui.select(title, items),
						input: (title, value) => ctx.ui.input(title, value),
						editWidgets: (title, allWidgets, enabled, onChange, onReject) =>
							ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) =>
								new WidgetsSetupComponent({
									title,
									allWidgets,
									enabled,
									theme,
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

		runState = "Ready";
		branchChanges = undefined;
		activeTools.clear();
		reloadConfig();

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
					const palette = selectPalette(theme.name);
					const usage = aggregateSessionUsage(ctx.sessionManager.getBranch());
					const context = ctx.getContextUsage();
					const thinking = ctx.model?.reasoning ? pi.getThinkingLevel() : "off";
					const snapshot: StatusSnapshot = {
						cwd: ctx.cwd,
						sessionName: ctx.sessionManager.getSessionName(),
						modelId: ctx.model?.id ?? "no-model",
						thinkingLevel: thinking,
						hasReasoning: Boolean(ctx.model?.reasoning),
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
						progress: joinExtensionProgress(footerData.getExtensionStatuses()),
						runState,
					};

					const segments = buildWidgetSegments(snapshot, config);
					const line = renderStatusLine(segments, config, palette, width, truncateToWidth);
					return [line];
				},
			};
		});

		scheduleGitRefresh(ctx.cwd, 0);
	});

	pi.on("agent_start", async () => setRunState("Thinking"));
	pi.on("turn_start", async () => setRunState("Thinking"));
	pi.on("agent_settled", async (_event, ctx) => {
		activeTools.clear();
		setRunState("Ready");
		scheduleGitRefresh(ctx.cwd, 0);
	});
	pi.on("tool_execution_start", async (event) => {
		activeTools.add(event.toolCallId);
		setRunState("Working");
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		activeTools.delete(event.toolCallId);
		setRunState(activeTools.size > 0 ? "Working" : "Thinking");
		scheduleGitRefresh(ctx.cwd);
	});
	pi.on("model_select", async () => requestRender());
	pi.on("thinking_level_select", async () => requestRender());
	pi.on("session_compact", async () => requestRender());
	pi.on("session_info_changed", async () => requestRender());
	pi.on("session_shutdown", async () => {
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		gitRefreshTimer = undefined;
		renderRequest = undefined;
		activeTools.clear();
	});
}
