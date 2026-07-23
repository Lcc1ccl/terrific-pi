import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	PILOT_ACTIVATION_ENTRY_TYPE,
	activateManualPilot,
	activationSource,
	changeModePolicy,
	deactivateManualPilot,
	isPilotActive,
	restoreActivationState,
	toActivationEntry,
	type PilotActivationState,
	type PilotMode,
} from "../lib/activation.ts";
import {
	requestPilotRoute,
	resolvePilotRoute,
	type AuxiliaryPilotRouterResponse,
} from "../lib/aux-router.ts";
import { MODE_STATUS_KEY, modeLabel, parseModeArg, roleContract, toolsForMode } from "../lib/mode.ts";

const PILOT_STATUS_KEY = "pilot";
const DEFAULT_STATE: PilotActivationState = { modePolicy: "auto", manualPilotActive: false };

function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, level);
}

export default function pilot(pi: ExtensionAPI): void {
	let state: PilotActivationState = { ...DEFAULT_STATE };
	let baselineTools: string[] = [];
	let baselineCaptured = false;
	let toolsReady = false;
	let lastRoute: Exclude<PilotMode, "auto"> | undefined;
	let routerController: AbortController | undefined;

	function captureBaseline(): void {
		if (baselineCaptured && baselineTools.length > 0) return;
		baselineTools = pi.getActiveTools();
		baselineCaptured = true;
	}

	function setTools(mode: PilotMode): void {
		captureBaseline();
		pi.setActiveTools(toolsForMode(mode, baselineTools));
	}

	function toolModeFor(nextState: PilotActivationState): PilotMode {
		return isPilotActive(nextState) ? "plan" : nextState.modePolicy;
	}

	function effectiveModeStatus(): string {
		if (state.modePolicy !== "auto") return modeLabel(state.modePolicy);
		return lastRoute ? `AUTO->${modeLabel(lastRoute)}` : "AUTO";
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(MODE_STATUS_KEY, toolsReady ? effectiveModeStatus() : undefined);
		ctx.ui.setStatus(PILOT_STATUS_KEY, toolsReady && activationSource(state) === "manual" ? "manual" : undefined);
	}

	function applyState(nextState: PilotActivationState, ctx: ExtensionContext, action: string): boolean {
		try {
			setTools(toolModeFor(nextState));
		} catch (error) {
			toolsReady = false;
			lastRoute = undefined;
			updateStatus(ctx);
			report(ctx, `${action}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
		state = nextState;
		toolsReady = true;
		updateStatus(ctx);
		return true;
	}

	function persist(): void {
		pi.appendEntry(PILOT_ACTIVATION_ENTRY_TYPE, toActivationEntry(state));
	}

	function setRoute(route: Exclude<PilotMode, "auto">, ctx: ExtensionContext): boolean {
		const previousRoute = lastRoute;
		lastRoute = route;
		try {
			setTools(route === "ask" ? "ask" : "plan");
		} catch (error) {
			lastRoute = previousRoute;
			toolsReady = false;
			updateStatus(ctx);
			report(ctx, `Pilot route tool policy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
		toolsReady = true;
		updateStatus(ctx);
		return true;
	}

	function changeMode(mode: PilotMode, ctx: ExtensionContext): boolean {
		const next = changeModePolicy(state, mode, { safeToLeaveAuto: ctx.isIdle() && !routerController });
		if (!next.ok) {
			report(ctx, next.reason, "warning");
			return false;
		}
		if (!applyState(next.state, ctx, "Mode switch tool policy failed")) return false;
		lastRoute = undefined;
		persist();
		return true;
	}

	function directRoute(): Exclude<PilotMode, "auto"> | undefined {
		if (!toolsReady) return undefined;
		if (!isPilotActive(state)) return state.modePolicy === "auto" ? undefined : state.modePolicy;
		return state.modePolicy === "auto" ? lastRoute : state.modePolicy;
	}

	pi.registerCommand("mode", {
		description: "Switch Pilot mode policy (ask|plan|edit|auto)",
		getArgumentCompletions: (prefix) => ["ask", "plan", "edit", "auto"]
			.filter((mode) => mode.startsWith(prefix.trim().toLowerCase()))
			.map((mode) => ({ value: mode, label: mode })),
		handler: async (args, ctx) => {
			const mode = parseModeArg(args);
			if (!mode) {
				report(ctx, "Usage: /mode ask|plan|edit|auto", "warning");
				return;
			}
			if (changeMode(mode, ctx)) report(ctx, `Mode: ${modeLabel(mode)}`);
		},
	});

	pi.registerCommand("pilot", {
		description: "Activate Pilot or inspect the Phase 0 routing spike (off|status|cancel)",
		getArgumentCompletions: (prefix) => ["off", "status", "cancel"]
			.filter((option) => option.startsWith(prefix.trim().toLowerCase()))
			.map((option) => ({ value: option, label: option })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status") {
				report(ctx, `Pilot: ${activationSource(state)} · mode ${effectiveModeStatus()}`);
				return;
			}
			if (action === "cancel") {
				if (!routerController) {
					report(ctx, "No Pilot route is running.", "warning");
					return;
				}
				routerController.abort();
				report(ctx, "Pilot route cancellation requested.");
				return;
			}
			if (action === "off") {
				const next = deactivateManualPilot(state, { safe: ctx.isIdle() && !routerController });
				if (!next.ok) {
					report(ctx, next.reason, "warning");
					return;
				}
				if (!applyState(next.state, ctx, "Pilot deactivation tool policy failed")) return;
				persist();
				report(ctx, "Pilot manual activation ended.");
				return;
			}
			if (action) {
				report(ctx, "Usage: /pilot [off|status|cancel]", "warning");
				return;
			}
			const next = activateManualPilot(state);
			if (!next.ok) {
				report(ctx, next.reason, "warning");
				return;
			}
			if (!applyState(next.state, ctx, "Pilot activation tool policy failed")) return;
			if (activationSource(state) === "manual") persist();
			report(ctx, activationSource(state) === "auto" ? "Pilot is active through AUTO." : "Pilot manual activation is active.");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		captureBaseline();
		state = restoreActivationState(ctx.sessionManager.getBranch(), DEFAULT_STATE);
		lastRoute = undefined;
		routerController = undefined;
		applyState(state, ctx, "Pilot session tool policy failed");
	});

	pi.on("session_tree", async (_event, ctx) => {
		routerController?.abort();
		routerController = undefined;
		lastRoute = undefined;
		const nextState = restoreActivationState(ctx.sessionManager.getBranch(), DEFAULT_STATE);
		applyState(nextState, ctx, "Pilot tree tool policy failed");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		routerController?.abort();
		routerController = undefined;
		toolsReady = false;
		ctx.ui.setStatus(MODE_STATUS_KEY, undefined);
		ctx.ui.setStatus(PILOT_STATUS_KEY, undefined);
		if (!baselineCaptured) return;
		try {
			pi.setActiveTools(baselineTools);
		} catch {}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !toolsReady || !isPilotActive(state)) return { action: "continue" };
		if (state.modePolicy !== "auto") {
			if (!setRoute(state.modePolicy, ctx)) return { action: "handled" };
			if (state.modePolicy === "ask") return { action: "continue" };
			report(ctx, `Pilot ${modeLabel(state.modePolicy)} route handled by the Phase 0 spike; no main-session work was started.`);
			return { action: "handled" };
		}
		if (routerController) {
			report(ctx, "Pilot is already routing a prompt.", "warning");
			return { action: "handled" };
		}

		lastRoute = undefined;
		updateStatus(ctx);
		const controller = new AbortController();
		routerController = controller;
		let response: AuxiliaryPilotRouterResponse;
		try {
			response = await requestPilotRoute({ events: pi.events, prompt: event.text, signal: controller.signal });
		} catch {
			if (controller.signal.aborted) {
				lastRoute = undefined;
				updateStatus(ctx);
				report(ctx, "Pilot route cancelled.");
				return { action: "handled" };
			}
			response = { version: 1, requestId: "unavailable", status: "failed" };
		} finally {
			if (routerController === controller) routerController = undefined;
		}
		const route = resolvePilotRoute(response);
		if (!setRoute(route.route, ctx)) return { action: "handled" };
		if (route.route === "ask") return { action: "continue" };
		report(ctx, `Pilot ${modeLabel(route.route)} route handled by the Phase 0 spike; no main-session work was started.`);
		return { action: "handled" };
	});

	pi.on("before_agent_start", async (event) => {
		const route = directRoute();
		if (!route) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${roleContract(route)}` };
	});
}
