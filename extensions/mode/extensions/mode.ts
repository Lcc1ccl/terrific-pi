/**
 * /mode — tool-permission modes: ask | plan | edit | auto
 * Does not change model or thinking level.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, resolveConfigPath, resolveConfigPaths, updateModeConfig, type ModeName } from "../lib/config.ts";
import {
	isModeName,
	MODE_ENTRY_TYPE,
	MODE_STATUS_KEY,
	modeLabel,
	parseModeArg,
	toolsForMode,
} from "../lib/mode-tools.ts";
import { report } from "../lib/output.ts";

interface ModeEntryData {
	mode: ModeName;
}

export default function (pi: ExtensionAPI) {
	let currentMode: ModeName = "edit";
	let baselineTools: string[] = [];
	let baselineCaptured = false;

	function captureBaseline(): void {
		if (baselineCaptured) return;
		baselineTools = pi.getActiveTools();
		baselineCaptured = true;
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(MODE_STATUS_KEY, modeLabel(currentMode));
	}

	function persist(mode: ModeName, persist: boolean): void {
		if (!persist) return;
		pi.appendEntry<ModeEntryData>(MODE_ENTRY_TYPE, { mode });
	}

	function readPersistedMode(ctx: ExtensionContext): ModeName | undefined {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE) {
				const data = entry.data as ModeEntryData | undefined;
				if (data && isModeName(data.mode)) return data.mode;
			}
		}
		return undefined;
	}

	function applyMode(mode: ModeName, ctx: ExtensionContext, options: { persist: boolean; notify: boolean }): boolean {
		if ((mode === "ask" || mode === "plan") && (currentMode === "edit" || currentMode === "auto")) {
			baselineTools = pi.getActiveTools();
			baselineCaptured = true;
		} else {
			captureBaseline();
		}
		const previousTools = pi.getActiveTools();
		const nextTools = toolsForMode(mode, baselineTools);

		try {
			pi.setActiveTools(nextTools);
		} catch (error) {
			try {
				pi.setActiveTools(previousTools);
			} catch {
				// ignore rollback failure
			}
			report(ctx, `Mode switch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}

		currentMode = mode;
		updateStatus(ctx);
		persist(mode, options.persist);

		if (options.notify) {
			const tools = pi.getActiveTools().join(", ");
			report(ctx, `Mode: ${modeLabel(mode)} (${tools})`);
		}

		return true;
	}

	const modeConfigSummary = (
		ctx: ExtensionContext,
		global: ReturnType<typeof loadConfig>["config"],
		effective: ReturnType<typeof loadConfig>["config"],
	) => [
		`Current mode: ${modeLabel(currentMode)}`,
		`Global default mode: ${global.mode.default} (package default ${DEFAULT_CONFIG.mode.default})`,
		`Global persist per session: ${global.mode.persistPerSession ? "on" : "off"} (package default ${DEFAULT_CONFIG.mode.persistPerSession ? "on" : "off"})`,
		`Effective mode: ${effective.mode.default} · persist ${effective.mode.persistPerSession ? "on" : "off"}`,
		`Effective sources: ${resolveConfigPaths(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), CONFIG_DIR_NAME).join(" -> ")}`,
		`Effective tools: ${pi.getActiveTools().join(", ") || "(none)"}`,
		`Write scope: global (${resolveConfigPath(getAgentDir())})`,
	].join("\n");

	const mutateGlobalMode = (ctx: ExtensionContext, mutate: (mode: Record<string, unknown>) => void, success: string) => {
		const result = updateModeConfig(getAgentDir(), mutate);
		if (!result.ok) {
			report(ctx, `Failed to update terrific.json: ${result.error}`, "error");
			return false;
		}
		report(ctx, success);
		return true;
	};

	const runModeConfig = async (ctx: ExtensionContext) => {
		const loadScopes = () => ({
			global: loadConfig(ctx.cwd, getAgentDir(), false, CONFIG_DIR_NAME),
			effective: loadConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), CONFIG_DIR_NAME),
		});
		if (!ctx.hasUI || ctx.mode !== "tui") {
			const { global, effective } = loadScopes();
			report(ctx, modeConfigSummary(ctx, global.config, effective.config));
			return;
		}
		while (true) {
			const { global, effective } = loadScopes();
			for (const warning of effective.warnings) report(ctx, warning, "warning");
			const choice = await ctx.ui.select([
				"Mode configuration",
				`write: global (${resolveConfigPath(getAgentDir())})`,
				`effective: ${effective.config.mode.default} · persist ${effective.config.mode.persistPerSession ? "on" : "off"}`,
				`source: ${resolveConfigPaths(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), CONFIG_DIR_NAME).join(" -> ")}`,
			].join("\n"), [
				`Global default mode: ${global.config.mode.default}`,
				`Global persist per session: ${global.config.mode.persistPerSession ? "on" : "off"}`,
				"Save current as default",
				"Show effective tools",
				"Reset global override",
				"Done",
			]);
			if (!choice || choice === "Done") return;
			if (choice.startsWith("Global default mode:")) {
				const next = await ctx.ui.select("Default mode", ["ask", "plan", "edit", "auto"]);
				if (next && isModeName(next)) mutateGlobalMode(ctx, (mode) => { mode.default = next; }, `Default mode: ${next}`);
			} else if (choice.startsWith("Global persist per session:")) {
				const next = await ctx.ui.select("Persist mode per session", ["On", "Off"]);
				if (next) mutateGlobalMode(ctx, (mode) => { mode.persistPerSession = next === "On"; }, `Persist per session: ${next.toLowerCase()}`);
			} else if (choice === "Save current as default") {
				mutateGlobalMode(ctx, (mode) => { mode.default = currentMode; }, `Saved ${currentMode} as the global default`);
			} else if (choice === "Show effective tools") {
				report(ctx, modeConfigSummary(ctx, global.config, effective.config));
			} else if (choice === "Reset global override") {
				const confirmed = await ctx.ui.confirm("Reset mode override?", "Remove global default and persist overrides while keeping unknown mode settings?");
				if (confirmed) mutateGlobalMode(ctx, (mode) => {
					delete mode.default;
					delete mode.persistPerSession;
				}, "Global mode override reset");
			}
		}
	};

	pi.registerCommand("mode", {
		description: "Switch tool permission mode or manage defaults (ask|plan|edit|auto|config)",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trim().toLowerCase();
			return ["ask", "plan", "edit", "auto", "config"].filter((option) => option.startsWith(value)).map((option) => ({ value: option, label: option }));
		},
		handler: async (args, ctx) => {
			const { config, warnings } = loadConfig(
				ctx.cwd,
				getAgentDir(),
				ctx.isProjectTrusted(),
				CONFIG_DIR_NAME,
			);
			for (const warning of warnings) report(ctx, warning, "warning");

			const arg = args.trim().toLowerCase();
			if (arg === "config") {
				await runModeConfig(ctx);
				return;
			}
			if (arg) {
				const mode = parseModeArg(arg);
				if (!mode) {
					report(ctx, "Usage: /mode [ask|plan|edit|auto|config]", "error");
					return;
				}
				applyMode(mode, ctx, { persist: config.mode.persistPerSession, notify: true });
				return;
			}

			if (!ctx.hasUI || ctx.mode !== "tui") {
				report(ctx, `Current mode: ${modeLabel(currentMode)}. Usage: /mode ask|plan|edit|auto|config`);
				return;
			}

			const choice = await ctx.ui.select("Execution mode", [
				`ask — read/grep/find/ls only${currentMode === "ask" ? " (current)" : ""}`,
				`plan — read-only tools${currentMode === "plan" ? " (current)" : ""}`,
				`edit — default toolset${currentMode === "edit" ? " (current)" : ""}`,
				`auto — same tools as edit${currentMode === "auto" ? " (current)" : ""}`,
			]);

			if (!choice) return;
			const mode = parseModeArg(choice.split("—")[0] ?? choice.split(" ")[0] ?? "");
			if (!mode) return;
			applyMode(mode, ctx, { persist: config.mode.persistPerSession, notify: true });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const { config, warnings } = loadConfig(
			ctx.cwd,
			getAgentDir(),
			ctx.isProjectTrusted(),
			CONFIG_DIR_NAME,
		);
		for (const warning of warnings) report(ctx, warning, "warning");

		// Capture baseline on first start for this runtime; re-capture if empty
		if (!baselineCaptured || baselineTools.length === 0) {
			baselineTools = pi.getActiveTools();
			baselineCaptured = true;
		}

		const persisted = config.mode.persistPerSession ? readPersistedMode(ctx) : undefined;
		const target = persisted ?? config.mode.default;
		applyMode(target, ctx, { persist: false, notify: false });
	});

	pi.on("session_shutdown", async () => {
		if (!baselineCaptured || (currentMode !== "ask" && currentMode !== "plan")) return;
		pi.setActiveTools(baselineTools);
	});
}
