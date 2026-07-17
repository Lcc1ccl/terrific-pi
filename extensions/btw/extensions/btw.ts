/**
 * /btw — one-shot side-channel Q&A over an isolated in-memory session.
 * Does not write to the main session or expose tools/resources.
 */

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	buildSessionContext,
	CONFIG_DIR_NAME,
	copyToClipboard,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { truncateMessagesForBtw } from "../lib/btw-context.ts";
import { createIsolatedBtwSession } from "../lib/btw-session.ts";
import { loadConfig } from "../lib/config.ts";
import { TextOverlay, type OverlayAction } from "../lib/overlay.ts";
import { report } from "../lib/output.ts";
import { charsToTokens, type ClassifiableMessage } from "../lib/tokens.ts";
import { BTW_SYSTEM_PROMPT } from "../lib/btw-context.ts";

type AskResult =
	| { status: "ok"; answer: string }
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

function extractAnswer(session: AgentSession): AskResult {
	const response = [...session.agent.state.messages]
		.reverse()
		.find((message): message is AssistantMessage => message.role === "assistant");
	if (!response) return { status: "error", message: "BTW request finished without a response" };
	if (response.stopReason === "aborted") return { status: "cancelled" };
	if (response.stopReason === "error") {
		return { status: "error", message: response.errorMessage || "BTW request failed" };
	}
	const answer = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return answer ? { status: "ok", answer } : { status: "error", message: "BTW response contained no text" };
}

function buildSnapshot(ctx: ExtensionCommandContext, question: string, maxContextTokens: number, maxOutputTokens: number): Message[] {
	const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const contextWindow = ctx.model?.contextWindow ?? maxContextTokens + maxOutputTokens;
	const reserved = maxOutputTokens + charsToTokens(BTW_SYSTEM_PROMPT) + charsToTokens(question) + 256;
	const budget = Math.max(0, Math.min(maxContextTokens, contextWindow - reserved));
	return truncateMessagesForBtw(context.messages as ClassifiableMessage[], budget) as Message[];
}

async function askQuestion(ctx: ExtensionCommandContext, question: string): Promise<AskResult> {
	const { config, warnings } = loadConfig(
		ctx.cwd,
		getAgentDir(),
		ctx.isProjectTrusted(),
		CONFIG_DIR_NAME,
	);
	for (const warning of warnings) report(ctx, warning, "warning");

	if (!ctx.model) return { status: "error", message: "No model selected" };
	const outputLimit = Math.min(config.btw.maxOutputTokens, ctx.model.maxTokens);
	const model = { ...ctx.model, maxTokens: outputLimit } as Model<typeof ctx.model.api>;
	const snapshot = buildSnapshot(ctx, question, config.btw.maxContextTokens, outputLimit);

	return await ctx.ui.custom<AskResult>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `BTW · ${model.id}…`);
		let cancelled = false;
		loader.onAbort = () => {
			cancelled = true;
			void activeSession?.abort();
		};

		const run = async (): Promise<AskResult> => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
			}
			if (cancelled) return { status: "cancelled" };

			const session = await createIsolatedBtwSession({
				cwd: ctx.cwd,
				model,
				thinkingLevel: config.btw.thinking,
				messages: snapshot,
				modelRegistry: ctx.modelRegistry,
			});
			activeSession = session;
			try {
				if (cancelled) return { status: "cancelled" };
				await session.prompt(question, { source: "extension" });
				if (activeSession !== session) return { status: "cancelled" };
				return extractAnswer(session);
			} finally {
				if (activeSession === session) await disposeActiveSession();
			}
		};

		run()
			.then(done)
			.catch((error) => {
				done({ status: "error", message: error instanceof Error ? error.message : String(error) });
			});
		return loader;
	});
}

async function showAnswer(
	ctx: ExtensionCommandContext,
	question: string,
	answer: string,
): Promise<"close" | "editor" | "retry"> {
	const lines = [`Q: ${question}`, "", ...answer.split("\n"), "", "(Not written to main session)"];
	const action = await ctx.ui.custom<OverlayAction>(
		(tui, theme, _keybindings, done) =>
			new TextOverlay(
				theme,
				{
					title: "BTW",
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
	pi.registerCommand("btw", {
		description: "Ask a side question without polluting the main session",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				report(ctx, "/btw is not supported in non-interactive mode", "error");
				return;
			}
			if (running) {
				ctx.ui.notify("A /btw request is already running", "warning");
				return;
			}

			let question = args.trim();
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
					const result = await askQuestion(ctx, question);
					if (result.status === "cancelled") {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					if (result.status === "error") {
						ctx.ui.notify(result.message, "error");
						return;
					}

					const next = await showAnswer(ctx, question, result.answer);
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
