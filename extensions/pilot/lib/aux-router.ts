import { randomUUID } from "node:crypto";

export const PILOT_ROUTER_REQUEST_EVENT = "terrific-pi:auxiliary:pilot-router:request-v1";
export const PILOT_ROUTER_STARTED_EVENT = "terrific-pi:auxiliary:pilot-router:started-v1";
export const PILOT_ROUTER_RESPONSE_EVENT = "terrific-pi:auxiliary:pilot-router:response-v1";
export const PILOT_ROUTER_CANCEL_EVENT = "terrific-pi:auxiliary:pilot-router:cancel-v1";

export interface PilotRouterEventBus {
	on(event: string, handler: (value: unknown) => void): (() => void) | void;
	emit(event: string, value: unknown): void;
}

export interface AuxiliaryPilotRouterResponse {
	version: 1;
	requestId: string;
	status: "completed" | "failed" | "timed_out" | "cancelled" | "invalid_request";
	decision?: unknown;
	error?: string;
}

export interface PilotRouterDecision {
	route: "ask" | "plan" | "edit";
	confidence: number;
	reasons: string[];
	riskFlags: string[];
}

export type PilotRouteResult =
	| { route: "ask" | "plan" | "edit"; decision: PilotRouterDecision }
	| { route: "plan"; fallbackReason: string };

function envelope(value: unknown, requestId: string): value is { version: 1; requestId: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.version === 1 && record.requestId === requestId;
}

export function requestPilotRoute(options: {
	events: PilotRouterEventBus;
	prompt: string;
	signal?: AbortSignal;
	requestId?: string;
	availabilityTimeoutMs?: number;
	timeoutMs?: number;
}): Promise<AuxiliaryPilotRouterResponse> {
	const requestId = options.requestId ?? randomUUID();
	return new Promise((resolve, reject) => {
		let settled = false;
		let availabilityTimer: ReturnType<typeof setTimeout> | undefined;
		let completionTimer: ReturnType<typeof setTimeout> | undefined;
		const unsubscribes: Array<() => void> = [];
		const subscribe = (event: string, handler: (value: unknown) => void) => {
			const unsubscribe = options.events.on(event, handler);
			if (typeof unsubscribe === "function") unsubscribes.push(unsubscribe);
		};
		const cleanup = () => {
			if (availabilityTimer) clearTimeout(availabilityTimer);
			if (completionTimer) clearTimeout(completionTimer);
			options.signal?.removeEventListener("abort", onAbort);
			for (const unsubscribe of unsubscribes) unsubscribe();
		};
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			action();
		};
		const cancel = (message: string) => {
			finish(() => reject(new Error(message)));
			options.events.emit(PILOT_ROUTER_CANCEL_EVENT, { version: 1, requestId });
		};
		const onAbort = () => cancel("pilot_router cancelled");
		const beginCompletionTimer = (candidate: unknown) => {
			if (completionTimer) clearTimeout(completionTimer);
			const timeoutMs = typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 1
				? Math.floor(candidate)
				: options.timeoutMs ?? 10_000;
			completionTimer = setTimeout(() => cancel("pilot_router timed out"), timeoutMs);
		};

		availabilityTimer = setTimeout(() => cancel("pilot_router unavailable"), options.availabilityTimeoutMs ?? 2_000);
		subscribe(PILOT_ROUTER_STARTED_EVENT, (value) => {
			if (!envelope(value, requestId)) return;
			if (availabilityTimer) clearTimeout(availabilityTimer);
			const timeoutMs = value && typeof value === "object" ? (value as { timeoutMs?: unknown }).timeoutMs : undefined;
			beginCompletionTimer(timeoutMs);
		});
		subscribe(PILOT_ROUTER_RESPONSE_EVENT, (value) => {
			if (!envelope(value, requestId)) return;
			finish(() => resolve(value as AuxiliaryPilotRouterResponse));
		});
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		options.events.emit(PILOT_ROUTER_REQUEST_EVENT, { version: 1, requestId, prompt: options.prompt });
	});
}

function parseDecision(value: unknown): PilotRouterDecision | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.route !== "ask" && record.route !== "plan" && record.route !== "edit") return undefined;
	if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) return undefined;
	if (!Array.isArray(record.reasons) || !Array.isArray(record.riskFlags)) return undefined;
	if (record.reasons.some((item) => typeof item !== "string") || record.riskFlags.some((item) => typeof item !== "string")) return undefined;
	return {
		route: record.route,
		confidence: record.confidence,
		reasons: [...record.reasons],
		riskFlags: [...record.riskFlags],
	};
}

export function resolvePilotRoute(response: AuxiliaryPilotRouterResponse): PilotRouteResult {
	if (response.status !== "completed") return { route: "plan", fallbackReason: "pilot_router failed" };
	const decision = parseDecision(response.decision);
	if (!decision) return { route: "plan", fallbackReason: "pilot_router returned an invalid schema" };
	if (decision.confidence < 0.7) return { route: "plan", fallbackReason: "pilot_router confidence is below 0.7" };
	return { route: decision.route, decision };
}
