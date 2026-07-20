/**
 * /btw — one-shot side-channel Q&A over an isolated in-memory session.
 * Does not write to the main session or expose tools/resources.
 */

import type { Api, AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	buildSessionContext,
	CONFIG_DIR_NAME,
	copyToClipboard,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { truncateMessagesForBtw } from "../lib/btw-context.ts";
import { createBtwUsageEntry, resolveBtwCandidates, type BtwCandidate } from "../lib/btw-route.ts";
import { createIsolatedBtwSession } from "../lib/btw-session.ts";
import { loadConfig, resolveConfigPaths, updateBtwConfig } from "../lib/config.ts";
import { formatBtwStatus, parseBtwCommandArgs, type BtwContextMode } from "../lib/command.ts";
import { TextOverlay, type OverlayAction } from "../lib/overlay.ts";
import { report } from "../lib/output.ts";
import { charsToTokens, type ClassifiableMessage } from "../lib/tokens.ts";
import { BTW_SYSTEM_PROMPT } from "../lib/btw-context.ts";

const AUXILIARY_USAGE_INGEST_EVENT = "terrific-pi:auxiliary-usage:ingest-v1";
const AUXILIARY_STATUS_KEY = "auxiliary";

type AskResult =
	| { status: "ok"; answer: string; model: string }
	| { status: "cancelled" }
	| { status: "error"; message: string };

let running = false;
let activeSession: AgentSession | null = null;

async function disposeActiveSession(): Promise<void> {
	const session = activeSession;
	activeSession = null;
	if (!session) return;
	try {
		if (session.isStreaming) await session.abort();
	} finally {
		session.dispose();
	}
}

function lastAssistant(session: AgentSession): AssistantMessage | undefined {
	return [...session.agent.state.messages]
		.reverse()
		.find((message): message is AssistantMessage => message.role === "assistant");
}

function extractAnswer(session: AgentSession, model: string): AskResult {
	const response = lastAssistant(session);
	if (!response) return { status: "error", message: "BTW request finished without a response" };
	if (response.stopReason === "aborted") return { status: "cancelled" };
	if (response.stopReason === "error") {
		return { status: "error", message: response.errorMessage || "BTW request failed" };
	}
	const answer = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return answer ? { status: "ok", answer, model } : { status: "error", message: "BTW response contained no text" };
}

function buildSnapshot(
	ctx: ExtensionCommandContext,
	question: string,
	maxContextTokens: number,
	maxOutputTokens: number,
	contextWindow: number,
	contextMode: BtwContextMode,
): Message[] {
	if (contextMode === "none") return [];
	const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const reserved = maxOutputTokens + charsToTokens(BTW_SYSTEM_PROMPT) + charsToTokens(question) + 256;
	const budget = Math.max(0, Math.min(maxContextTokens, contextWindow - reserved));
	return truncateMessagesForBtw(context.messages as ClassifiableMessage[], budget) as Message[];
}

function publishUsage(
	pi: ExtensionAPI,
	candidate: BtwCandidate,
	status: "ok" | "error" | "aborted" | "timeout",
	startedAt: number,
	usage?: Usage,
	errorCode?: "auth_unavailable" | "timeout" | "aborted" | "provider_error" | "empty_response",
): void {
	pi.events.emit(AUXILIARY_USAGE_INGEST_EVENT, createBtwUsageEntry(candidate, status, startedAt, Date.now(), usage, errorCode));
}

function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`.replace(/[\u0000-\u001f\u007f]/g, "");
}

async function askQuestion(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	question: string,
	contextMode: BtwContextMode,
): Promise<AskResult> {
	const { config, warnings } = loadConfig(
		ctx.cwd,
		getAgentDir(),
		ctx.isProjectTrusted(),
		CONFIG_DIR_NAME,
	);
	for (const warning of warnings) report(ctx, warning, "warning");

	const candidates = resolveBtwCandidates({
		route: config.auxiliaryBtw,
		current: ctx.model as Model<Api> | undefined,
		legacyThinking: config.btw.thinking,
		legacyMaxOutputTokens: config.btw.maxOutputTokens,
		find: (provider, id) => ctx.modelRegistry.find(provider, id) as Model<Api> | undefined,
	});
	if (candidates.length === 0) return { status: "error", message: config.auxiliaryBtw ? "Configured BTW model is unavailable" : "No model selected" };

	return await ctx.ui.custom<AskResult>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `BTW · ${modelLabel(candidates[0]!.model)}…`);
		let cancelled = false;
		loader.onAbort = () => {
			cancelled = true;
			void activeSession?.abort().catch(() => {});
		};

		const run = async (): Promise<AskResult> => {
			let lastError = "BTW request failed";
			try {
				for (const candidate of candidates) {
					if (cancelled) return { status: "cancelled" };
					const label = modelLabel(candidate.model);
					const model = { ...candidate.model, maxTokens: candidate.maxOutputTokens } as Model<Api>;
					const snapshot = buildSnapshot(
						ctx,
						question,
						config.btw.maxContextTokens,
						candidate.maxOutputTokens,
						model.contextWindow,
						contextMode,
					);
					const startedAt = Date.now();
					let session: AgentSession | undefined;
					let timer: ReturnType<typeof setTimeout> | undefined;
					let timedOut = false;
					ctx.ui.setStatus(AUXILIARY_STATUS_KEY, `aux btw · ${model.id}`);
					try {
						session = await createIsolatedBtwSession({
							cwd: ctx.cwd,
							model,
							thinkingLevel: candidate.thinking,
							messages: snapshot,
							modelRegistry: ctx.modelRegistry,
						});
						activeSession = session;
						if (cancelled) {
							publishUsage(pi, candidate, "aborted", startedAt, undefined, "aborted");
							return { status: "cancelled" };
						}
						if (candidate.timeoutMs > 0) {
							timer = setTimeout(() => {
								timedOut = true;
								void session?.abort().catch(() => {});
							}, candidate.timeoutMs);
						}
						await session.prompt(question, { source: "extension" });
						const response = lastAssistant(session);
						if (cancelled) {
							publishUsage(pi, candidate, "aborted", startedAt, response?.usage, "aborted");
							return { status: "cancelled" };
						}
						if (timedOut) {
							publishUsage(pi, candidate, "timeout", startedAt, response?.usage, "timeout");
							lastError = `BTW request timed out for ${label}`;
							continue;
						}
						const result = extractAnswer(session, label);
						if (result.status === "ok") {
							publishUsage(pi, candidate, "ok", startedAt, response?.usage);
							return result;
						}
						if (result.status === "cancelled") {
							publishUsage(pi, candidate, "aborted", startedAt, response?.usage, "aborted");
							return result;
						}
						lastError = result.message;
						publishUsage(pi, candidate, "error", startedAt, response?.usage,
							result.message.includes("no text") ? "empty_response" : "provider_error");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (cancelled) {
							publishUsage(pi, candidate, "aborted", startedAt, session ? lastAssistant(session)?.usage : undefined, "aborted");
							return { status: "cancelled" };
						}
						if (timedOut) {
							publishUsage(pi, candidate, "timeout", startedAt, session ? lastAssistant(session)?.usage : undefined, "timeout");
							lastError = `BTW request timed out for ${label}`;
						} else {
							const authFailure = /api key|auth|credential/i.test(message);
							publishUsage(pi, candidate, "error", startedAt, session ? lastAssistant(session)?.usage : undefined, authFailure ? "auth_unavailable" : "provider_error");
							lastError = authFailure ? `Authentication unavailable for ${label}` : `BTW request failed for ${label}`;
						}
					} finally {
						if (timer) clearTimeout(timer);
						if (session && activeSession === session) await disposeActiveSession();
						else session?.dispose();
					}
				}
				return { status: "error", message: lastError };
			} finally {
				ctx.ui.setStatus(AUXILIARY_STATUS_KEY, undefined);
			}
		};

		run().then(done).catch((error) => {
			done({ status: "error", message: error instanceof Error ? error.message : String(error) });
		});
		return loader;
	});
}

async function showAnswer(
	ctx: ExtensionCommandContext,
	question: string,
	answer: string,
	model: string,
): Promise<"close" | "editor" | "retry"> {
	const lines = [`Q: ${question}`, "", ...answer.split("\n"), "", "(Not written to main session)"];
	const action = await ctx.ui.custom<OverlayAction>(
		(tui, theme, _keybindings, done) =>
			new TextOverlay(
				theme,
				{
					title: `BTW · ${model}`,
					lines,
					footer: "[c] copy  [e] editor  [r] retry  [Esc] close",
					extraKeys: [
						{ key: "e", action: "extra", hint: "editor" },
						{ key: "r", action: "enter", hint: "retry" },
					],
				},
				done,
				() => tui.requestRender(),
			),
		{ overlay: true },
	);

	if (action === "copy") {
		try {
			await copyToClipboard(answer);
			ctx.ui.notify("Copied answer", "info");
		} catch {
			ctx.ui.notify("Copy failed", "error");
		}
		return "close";
	}
	if (action === "extra") return "editor";
	if (action === "enter") return "retry";
	return "close";
}

export default function (pi: ExtensionAPI) {
	const runBtwConfig = async (ctx: ExtensionCommandContext) => {
		const paths = resolveConfigPaths(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), CONFIG_DIR_NAME);
		const loadScopes = () => ({
			global: loadConfig(ctx.cwd, getAgentDir(), false, CONFIG_DIR_NAME),
			effective: loadConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), CONFIG_DIR_NAME),
		});
		if (!ctx.hasUI || ctx.mode !== "tui") {
			const { effective } = loadScopes();
			for (const warning of effective.warnings) report(ctx, warning, "warning");
			report(ctx, `${formatBtwStatus(effective.config, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, paths)}\nUse /btw config in TUI to edit the context budget.`);
			return;
		}
		let scope = "global" as "global" | "project";
		while (true) {
			const { global, effective } = loadScopes();
			for (const warning of effective.warnings) report(ctx, warning, "warning");
			const targetPath = scope === "project" ? paths[1]! : paths[0]!;
			const target = scope === "global" ? global.config : effective.config;
			const choice = await ctx.ui.select([
				"BTW configuration",
				`write: ${scope} (${targetPath})`,
				`effective: ${effective.config.btw.maxContextTokens}`,
				`source: ${paths.join(" -> ")}`,
			].join("\n"), [
				...(paths.length > 1 ? [`Scope: ${scope}`] : []),
				`Write target context budget: ${target.btw.maxContextTokens}`,
				"Auxiliary route: /aux config -> btw",
				"Reset context budget override",
				"Show effective config",
				"Done",
			]);
			if (!choice || choice === "Done") return;
			if (choice.startsWith("Scope:")) {
				const selected = await ctx.ui.select("BTW config scope", ["global", "project"]);
				if (selected === "global" || selected === "project") scope = selected;
				continue;
			}
			if (choice.startsWith("Write target context budget:")) {
				const raw = await ctx.ui.input("Context budget (1-1000000 tokens)", String(target.btw.maxContextTokens));
				if (raw === undefined || !raw.trim()) continue;
				if (!/^\d+$/.test(raw.trim())) {
					ctx.ui.notify("Context budget must be an integer from 1 to 1000000", "warning");
					continue;
				}
				const maxContextTokens = Number.parseInt(raw.trim(), 10);
				if (maxContextTokens < 1 || maxContextTokens > 1_000_000) {
					ctx.ui.notify("Context budget must be an integer from 1 to 1000000", "warning");
					continue;
				}
				const result = updateBtwConfig(targetPath, (btw) => { btw.maxContextTokens = maxContextTokens; });
				if (!result.ok) ctx.ui.notify(`Failed to update terrific.json: ${result.error}`, "error");
				else ctx.ui.notify(`Context budget: ${maxContextTokens}`, "info");
				continue;
			}
			if (choice.startsWith("Auxiliary route:")) {
				ctx.ui.notify("Configure BTW model, thinking, timeout, output cap, and fallbacks through /aux config -> btw.", "info");
				continue;
			}
			if (choice === "Reset context budget override") {
				if (!await ctx.ui.confirm("Reset BTW context budget?", `Remove maxContextTokens from ${scope} scope while preserving other BTW settings?`)) continue;
				const result = updateBtwConfig(targetPath, (btw) => { delete btw.maxContextTokens; });
				if (!result.ok) ctx.ui.notify(`Failed to update terrific.json: ${result.error}`, "error");
				else ctx.ui.notify(`${scope} BTW budget override reset`, "info");
				continue;
			}
			report(ctx, formatBtwStatus(effective.config, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, paths));
		}
	};

	pi.registerCommand("btw", {
		description: "Ask a side question without polluting the main session (status|config|context=none)",
		getArgumentCompletions: (prefix) => ["status", "config", "context=current", "context=none"].filter((option) => option.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const raw = args.trim();
			const { config, warnings } = loadConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), CONFIG_DIR_NAME);
			for (const warning of warnings) report(ctx, warning, "warning");
			if (raw.toLowerCase() === "status") {
				report(ctx, formatBtwStatus(
					config,
					ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					resolveConfigPaths(ctx.cwd, getAgentDir(), ctx.isProjectTrusted(), CONFIG_DIR_NAME),
				));
				return;
			}
			if (raw.toLowerCase() === "config") {
				await runBtwConfig(ctx);
				return;
			}
			if (!ctx.hasUI || ctx.mode !== "tui") {
				report(ctx, "/btw is not supported in non-interactive mode", "error");
				return;
			}
			if (running) {
				ctx.ui.notify("A /btw request is already running", "warning");
				return;
			}

			const parsed = parseBtwCommandArgs(raw);
			let question = parsed.question;
			if (!question) {
				const input = await ctx.ui.input("BTW question", "");
				if (input === undefined) return;
				question = input.trim();
			}
			if (!question) {
				ctx.ui.notify("Question required", "error");
				return;
			}

			running = true;
			try {
				while (true) {
					const result = await askQuestion(pi, ctx, question, parsed.contextMode);
					if (result.status === "cancelled") {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					if (result.status === "error") {
						ctx.ui.notify(result.message, "error");
						return;
					}

					const next = await showAnswer(ctx, question, result.answer, result.model);
					if (next === "editor") {
						ctx.ui.setEditorText(result.answer);
						ctx.ui.notify("Answer placed in editor (not sent)", "info");
						return;
					}
					if (next !== "retry") return;
				}
			} finally {
				await disposeActiveSession();
				running = false;
			}
		},
	});

	pi.on("session_shutdown", async () => {
		await disposeActiveSession();
		running = false;
	});
}
