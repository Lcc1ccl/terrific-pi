/**
 * /fast — toggle OpenAI Priority processing (service_tier: priority).
 *
 * Works for openai-responses / openai-codex-responses models.
 * Cost ~2x (gpt-5.5 ~2.5x). Not a thinking-level control.
 *
 * Usage:
 *   /fast          toggle
 *   /fast on|off   set explicitly
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FAST_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);

function supportsFast(ctx: ExtensionContext): boolean {
	const api = ctx.model?.api;
	return typeof api === "string" && FAST_APIS.has(api);
}

function applyStatus(ctx: ExtensionContext, fast: boolean): void {
	ctx.ui.setStatus("fast", fast ? "" : undefined);
}

export default function (pi: ExtensionAPI) {
	let fast = false;

	const setFast = (ctx: ExtensionContext, next: boolean) => {
		fast = next;
		applyStatus(ctx, fast);
		if (fast && !supportsFast(ctx)) {
			ctx.ui.notify(
				"Fast on, but current model API may ignore service_tier (needs openai/codex responses).",
				"warning",
			);
			return;
		}
		ctx.ui.notify(fast ? "Fast mode ON (service_tier=priority)" : "Fast mode OFF", "info");
	};

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Priority processing (service_tier=priority)",
		getArgumentCompletions: (prefix) => {
			const opts = ["on", "off", "toggle"];
			const filtered = opts.filter((o) => o.startsWith(prefix.trim()));
			return filtered.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") setFast(ctx, true);
			else if (arg === "off") setFast(ctx, false);
			else if (arg === "" || arg === "toggle") setFast(ctx, !fast);
			else ctx.ui.notify("Usage: /fast [on|off|toggle]", "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		applyStatus(ctx, fast);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fast) return;
		if (!supportsFast(ctx)) return;
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
		return { ...(payload as Record<string, unknown>), service_tier: "priority" };
	});
}
