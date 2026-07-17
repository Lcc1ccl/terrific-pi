/**
 * /mode — tool-permission modes: ask | plan | edit | auto
 * Does not change model or thinking level.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig, type ModeName } from "../lib/config.ts";
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

	pi.registerCommand("mode", {
		description: "Switch tool permission mode (ask|plan|edit|auto)",
		handler: async (args, ctx) => {
			const { config, warnings } = loadConfig(
				ctx.cwd,
				getAgentDir(),
				ctx.isProjectTrusted(),
				CONFIG_DIR_NAME,
			);
			for (const warning of warnings) report(ctx, warning, "warning");

			const arg = args.trim();
			if (arg) {
				const mode = parseModeArg(arg);
				if (!mode) {
					report(ctx, "Usage: /mode [ask|plan|edit|auto]", "error");
					return;
				}
				applyMode(mode, ctx, { persist: config.mode.persistPerSession, notify: true });
				return;
			}

			if (!ctx.hasUI || ctx.mode !== "tui") {
				report(ctx, `Current mode: ${modeLabel(currentMode)}. Usage: /mode ask|plan|edit|auto`);
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
