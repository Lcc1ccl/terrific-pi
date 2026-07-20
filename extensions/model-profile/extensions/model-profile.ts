/**
 * /profile — short-list model + thinking switcher.
 *
 * Session scope restores settings.json after pi.setModel (which always persists).
 * Official /model and Ctrl+P still update global defaults (pi core behavior).
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import {
	applyProfile,
	applyResultLevel,
	formatApplySuccess,
	type ApplyDeps,
} from "../lib/apply.ts";
import { patchModelProfileSection } from "../lib/config-write.ts";
import {
	findProfile,
	findProfileByHotkey,
	isProfileScope,
	loadConfig,
	profileLabel,
} from "../lib/config.ts";
import { findMatchingProfile } from "../lib/match.ts";
import { report } from "../lib/output.ts";
import { readSettingsDefaults, writeSettingsDefaults } from "../lib/settings-defaults.ts";
import { formatOfficialDefaultsTip } from "../lib/official-tip.ts";
import {
	formatManualApplyMessage,
	manualResultLevel,
	runStartupPicker,
} from "../lib/startup.ts";
import type { ModelProfile, ProfileScope, ThinkingLevel } from "../lib/types.ts";

const SCOPE_SESSION = "session — this chat only";
const SCOPE_GLOBAL = "global — also update defaults";

function makeDeps(pi: ExtensionAPI, ctx: ExtensionContext): ApplyDeps {
	const agentDir = getAgentDir();
	return {
		findModel: (provider, modelId) => {
			const model = ctx.modelRegistry.find(provider, modelId);
			if (!model) return undefined;
			return { provider: model.provider, id: model.id };
		},
		setModel: async (model) => {
			const full = ctx.modelRegistry.find(model.provider, model.id);
			if (!full) return false;
			return pi.setModel(full);
		},
		setThinkingLevel: (level) => {
			pi.setThinkingLevel(level);
		},
		getThinkingLevel: () => pi.getThinkingLevel() as ThinkingLevel,
		readSettingsDefaults: () => readSettingsDefaults(agentDir),
		writeSettingsDefaults: (defaults) => {
			const result = writeSettingsDefaults(defaults, agentDir);
			return result.ok ? { ok: true } : { ok: false, error: result.error };
		},
	};
}

function load(ctx: ExtensionContext) {
	return loadConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), CONFIG_DIR_NAME);
}

function formatList(
	profiles: readonly ModelProfile[],
	currentId: string | undefined,
	startup: boolean,
): string {
	if (profiles.length === 0) {
		return "No profiles configured. Add modelProfile.profiles to ~/.pi/agent/terrific.json";
	}
	const lines = profiles.map((p) => {
		const mark = currentId && p.id === currentId ? " *" : "";
		const hotkey = p.hotkey ? `  [${p.hotkey}]` : "";
		return `- ${p.id}${mark} · ${p.alias}: ${p.provider}/${p.model} · ${p.thinking}${hotkey}`;
	});
	return `Profiles (${profiles.length}) · startup=${startup ? "on" : "off"}:\n${lines.join("\n")}`;
}

function formatStatus(
	profiles: readonly ModelProfile[],
	ctx: ExtensionContext,
	thinking: ThinkingLevel,
	startup: boolean,
	startupScope: ProfileScope,
): string {
	const model = ctx.model;
	const modelText = model ? `${model.provider}/${model.id}` : "(none)";
	const match = findMatchingProfile(
		profiles,
		model ? { provider: model.provider, id: model.id } : undefined,
		thinking,
	);
	const matchText = match ? `${match.id} · ${match.alias}` : "(none)";
	return [
		`Current: ${modelText} · ${thinking}`,
		`Matched profile: ${matchText}`,
		`Startup picker: ${startup ? "on" : "off"} (preferred scope: ${startupScope})`,
		"Note: official /model and Ctrl+P still update global defaults (pi core).",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const registeredHotkeys = new Set<string>();
	/** Serialize applies so snapshot/restore cannot interleave. */
	let applyQueue: Promise<void> = Promise.resolve();
	/** While >0, ignore model_select/thinking tips (our own setModel/setThinking). */
	let suppressDefaultsTip = 0;

	async function withSuppressedDefaultsTip<T>(fn: () => Promise<T>): Promise<T> {
		suppressDefaultsTip += 1;
		try {
			return await fn();
		} finally {
			suppressDefaultsTip -= 1;
		}
	}

	function enqueueApply(task: () => Promise<void>): Promise<void> {
		const run = applyQueue.then(task, task);
		applyQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async function runApply(
		ctx: ExtensionContext,
		profile: ModelProfile,
		scope: ProfileScope,
	): Promise<void> {
		await enqueueApply(async () => {
			await withSuppressedDefaultsTip(async () => {
				const result = await applyProfile(profile, scope, makeDeps(pi, ctx));
				if (!result.ok) {
					report(ctx, result.reason, "error");
					return;
				}
				report(ctx, formatApplySuccess(result), applyResultLevel(result));
			});
		});
	}

	async function pickScope(
		ctx: ExtensionContext,
		preferred: ProfileScope,
	): Promise<ProfileScope | undefined> {
		if (!ctx.hasUI || ctx.mode !== "tui") return preferred;
		const options =
			preferred === "global" ? [SCOPE_GLOBAL, SCOPE_SESSION] : [SCOPE_SESSION, SCOPE_GLOBAL];
		const choice = await ctx.ui.select("Apply scope", options);
		if (!choice) return undefined;
		return choice.startsWith("global") ? "global" : "session";
	}

	function parseArgs(args: string): {
		cmd?: "list" | "status" | "help" | "startup";
		startupValue?: boolean;
		id?: string;
		scope?: ProfileScope;
		error?: string;
	} {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) return {};

		const head = parts[0]!.toLowerCase();
		if (head === "list" || head === "status" || head === "help") {
			return { cmd: head };
		}

		if (head === "startup") {
			if (parts.length === 1) return { cmd: "startup" };
			const value = parts[1]!.toLowerCase();
			if (value === "on" || value === "true" || value === "1") {
				return { cmd: "startup", startupValue: true };
			}
			if (value === "off" || value === "false" || value === "0") {
				return { cmd: "startup", startupValue: false };
			}
			return { error: "Usage: /profile startup [on|off]" };
		}

		const id = parts[0];
		if (parts.length === 1) return { id };

		const scopeRaw = parts[1]!.toLowerCase();
		if (!isProfileScope(scopeRaw)) {
			return { error: `Unknown scope "${parts[1]}". Use session or global.` };
		}
		if (parts.length > 2) {
			return { error: "Usage: /profile [list|status|help|startup| <id> [session|global]]" };
		}
		return { id, scope: scopeRaw };
	}

	async function interactivePick(ctx: ExtensionContext): Promise<void> {
		const { config, warnings } = load(ctx);
		for (const warning of warnings) report(ctx, warning, "warning");

		if (config.profiles.length === 0) {
			report(
				ctx,
				"No profiles configured. Add modelProfile.profiles to ~/.pi/agent/terrific.json (see extension examples/config.json).",
				"warning",
			);
			return;
		}

		if (!ctx.hasUI || ctx.mode !== "tui") {
			const thinking = pi.getThinkingLevel() as ThinkingLevel;
			const matched = findMatchingProfile(
				config.profiles,
				ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				thinking,
			);
			report(ctx, formatList(config.profiles, matched?.id, config.startup));
			report(ctx, "Usage: /profile <id|alias> [session|global]  (interactive select requires TUI)");
			return;
		}

		const thinking = pi.getThinkingLevel() as ThinkingLevel;
		const matched = findMatchingProfile(
			config.profiles,
			ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			thinking,
		);
		const options = config.profiles.map((p) => {
			const cur = matched && matched.id === p.id ? " (current)" : "";
			return `${profileLabel(p)}${cur}`;
		});
		const choice = await ctx.ui.select("Model profile", options);
		if (!choice) return;

		const index = options.indexOf(choice);
		const profile = index >= 0 ? config.profiles[index] : undefined;
		if (!profile) return;

		const scope = await pickScope(ctx, "session");
		if (!scope) return;
		await runApply(ctx, profile, scope);
	}

	async function ensureHotkeys(ctx: ExtensionContext): Promise<void> {
		const { config } = load(ctx);

		const openHotkey = config.openHotkey;
		if (openHotkey && !registeredHotkeys.has(openHotkey)) {
			registeredHotkeys.add(openHotkey);
			pi.registerShortcut(openHotkey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
				description: "model-profile: open picker",
				handler: async (shortcutCtx) => {
					await interactivePick(shortcutCtx);
				},
			});
		}

		for (const profile of config.profiles) {
			const hotkey = profile.hotkey;
			if (!hotkey) continue;
			if (registeredHotkeys.has(hotkey)) {
				if (openHotkey === hotkey || config.profiles.some((p) => p.id !== profile.id && p.hotkey === hotkey)) {
					report(
						ctx,
						`model-profile: hotkey ${hotkey} already bound; profile ${profile.id} (${profile.alias}) skipped. Change hotkey or /reload after config edits.`,
						"warning",
					);
				}
				continue;
			}
			registeredHotkeys.add(hotkey);
			const boundId = profile.id;
			pi.registerShortcut(hotkey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
				description: `model-profile: ${boundId}`,
				handler: async (shortcutCtx) => {
					const { config: latest, warnings: latestWarnings } = load(shortcutCtx);
					for (const warning of latestWarnings) report(shortcutCtx, warning, "warning");
					const target =
						findProfile(latest.profiles, boundId) ??
						findProfileByHotkey(latest.profiles, hotkey);
					if (!target) {
						report(shortcutCtx, `Profile for hotkey ${hotkey} not found in config`, "warning");
						return;
					}
					await runApply(shortcutCtx, target, "session");
				},
			});
		}
	}

	pi.registerCommand("profile", {
		description:
			"Switch model+thinking profile. /profile [list|status|startup| <id|alias> [session|global]]",
		handler: async (args, ctx) => {
			const { config, warnings } = load(ctx);
			for (const warning of warnings) report(ctx, warning, "warning");
			await ensureHotkeys(ctx);

			const parsed = parseArgs(args);
			if (parsed.error) {
				report(ctx, parsed.error, "error");
				return;
			}

			const thinking = pi.getThinkingLevel() as ThinkingLevel;
			const matched = findMatchingProfile(
				config.profiles,
				ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				thinking,
			);

			if (parsed.cmd === "help") {
				report(
					ctx,
					[
						"Usage:",
						"  /profile                      pick profile, then scope",
						"  /profile list                 list profiles",
						"  /profile status               current match + startup flag",
						"  /profile startup [on|off]     cold-start /new short-list picker",
						"  /profile <id|alias>           session apply (e.g. 1 or default)",
						"  /profile <id|alias> session|global",
						"  alt+N                         jump to profile N (session-only)",
						"  openHotkey (default ctrl+alt+l) opens the picker",
						"",
						"Session apply restores settings.json defaults after switch (pi setModel persists otherwise).",
						"Global apply keeps the new defaults.",
						"Official /model and Ctrl+P still update global defaults — use /profile for session-only.",
						"Config: ~/.pi/agent/terrific.json → modelProfile.",
						"After editing hotkeys, run /reload.",
					].join("\n"),
				);
				return;
			}

			if (parsed.cmd === "list") {
				report(ctx, formatList(config.profiles, matched?.id, config.startup));
				return;
			}

			if (parsed.cmd === "status") {
				report(
					ctx,
					formatStatus(config.profiles, ctx, thinking, config.startup, config.startupScope),
				);
				return;
			}

			if (parsed.cmd === "startup") {
				if (parsed.startupValue === undefined) {
					report(
						ctx,
						`Startup picker is ${config.startup ? "on" : "off"} (preferred scope: ${config.startupScope}). Use /profile startup on|off`,
					);
					return;
				}
				const written = patchModelProfileSection(
					{ startup: parsed.startupValue },
					getAgentDir(),
				);
				if (!written.ok) {
					report(ctx, `Failed to update terrific.json: ${written.error}`, "error");
					return;
				}
				report(ctx, `Startup picker ${parsed.startupValue ? "enabled" : "disabled"} (${written.path})`);
				return;
			}

			if (parsed.id) {
				const profile = findProfile(config.profiles, parsed.id);
				if (!profile) {
					report(ctx, `Unknown profile "${parsed.id}" (id or alias). Try /profile list`, "error");
					return;
				}
				const scope = parsed.scope ?? "session";
				await runApply(ctx, profile, scope);
				return;
			}

			await interactivePick(ctx);
		},
	});

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		const { config, warnings } = load(ctx);
		for (const warning of warnings) report(ctx, warning, "warning");
		await ensureHotkeys(ctx);

		const startup = await withSuppressedDefaultsTip(() =>
			runStartupPicker({
				reason: event.reason,
				hasUI: ctx.hasUI && ctx.mode === "tui",
				config,
				deps: makeDeps(pi, ctx),
				currentModel: ctx.model
					? { provider: ctx.model.provider, id: ctx.model.id }
					: null,
				currentThinking: pi.getThinkingLevel() as ThinkingLevel,
				getAvailable: () =>
					ctx.modelRegistry.getAvailable().map((m) => ({
						provider: m.provider,
						id: m.id,
						name: typeof m.name === "string" ? m.name : undefined,
					})),
				ui: {
					select: (title, options) => ctx.ui.select(title, options),
				},
			}),
		);

		if (startup.action === "skipped") return;
		if (startup.action === "cancelled") {
			if (startup.reason.startsWith("No API key")) {
				report(ctx, startup.reason, "error");
			}
			return;
		}

		if (startup.source === "manual") {
			report(ctx, formatManualApplyMessage(startup), manualResultLevel(startup));
			return;
		}

		if (!startup.result.ok) {
			report(ctx, startup.result.reason, "error");
			return;
		}
		report(ctx, formatApplySuccess(startup.result), applyResultLevel(startup.result));
	});

	// Official /model, Ctrl+P, Shift+Tab: pi persists defaults — surface a clear tip.
	// Our own /profile and startup applies suppress this tip.
	pi.on("model_select", async (event, ctx) => {
		if (suppressDefaultsTip > 0) return;
		if (event.source === "restore") return;
		const detail = `${event.model.provider}/${event.model.id}`;
		const kind = event.source === "cycle" ? "cycle" : "model";
		report(ctx, formatOfficialDefaultsTip(kind, detail), "warning");
	});
	pi.on("thinking_level_select", async (event, ctx) => {
		if (suppressDefaultsTip > 0) return;
		report(ctx, formatOfficialDefaultsTip("thinking", String(event.level)), "warning");
	});
}
