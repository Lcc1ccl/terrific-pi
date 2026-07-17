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

/** Pure helper — inject service_tier into a provider payload object. */
export function injectPriority(payload: unknown): unknown | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const body = payload as Record<string, unknown>;
	// Mutate in place so callers that ignore the return still see the field
	// (event.payload shares the original params reference in pi-ai).
	body.service_tier = "priority";
	return body;
}

function modelApi(ctx: ExtensionContext): string | undefined {
	try {
		const api = ctx.model?.api;
		return typeof api === "string" ? api : undefined;
	} catch {
		// Stale extension ctx must not block toggle/request paths.
		return undefined;
	}
}

function supportsFast(ctx: ExtensionContext): boolean {
	const api = modelApi(ctx);
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

	// Do not gate on supportsFast here: a missing/stale ctx.model used to
	// silently skip injection while the status badge still showed ON.
	pi.on("before_provider_request", (event) => {
		if (!fast) return;
		return injectPriority(event.payload);
	});
}
