import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	PILOT_ROUTER_CANCEL_EVENT,
	PILOT_ROUTER_REQUEST_EVENT,
	PILOT_ROUTER_RESPONSE_EVENT,
	PILOT_ROUTER_STARTED_EVENT,
	requestPilotRoute,
	resolvePilotRoute,
} from "../lib/aux-router.ts";

class Events {
	private readonly handlers = new Map<string, Array<(value: unknown) => void>>();

	on(name: string, handler: (value: unknown) => void): () => void {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
		return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
	}

	emit(name: string, value: unknown): void {
		for (const handler of this.handlers.get(name) ?? []) handler(value);
	}
}

describe("Pilot Auxiliary router bridge", () => {
	test("uses one request and accepts an ASK decision", async () => {
		const events = new Events();
		let requests = 0;
		events.on(PILOT_ROUTER_REQUEST_EVENT, (value) => {
			const request = value as { version: number; requestId: string };
			requests += 1;
			events.emit(PILOT_ROUTER_STARTED_EVENT, { version: 1, requestId: request.requestId });
			events.emit(PILOT_ROUTER_RESPONSE_EVENT, {
			version: 1,
			requestId: request.requestId,
			status: "completed",
			decision: { route: "ask", confidence: 0.91, reasons: ["question"], riskFlags: [] },
		});
		});

		const response = await requestPilotRoute({ events, prompt: "Explain this module" });
		assert.equal(requests, 1);
		assert.deepEqual(resolvePilotRoute(response), {
			route: "ask",
			decision: { route: "ask", confidence: 0.91, reasons: ["question"], riskFlags: [] },
		});
	});

	test("falls back to PLAN for a malformed, low-confidence, or failed response", () => {
		assert.deepEqual(resolvePilotRoute({
			version: 1,
			requestId: "bad",
			status: "completed",
			decision: { route: "edit", confidence: "high" },
		}), { route: "plan", fallbackReason: "pilot_router returned an invalid schema" });
		assert.deepEqual(resolvePilotRoute({
			version: 1,
			requestId: "low",
			status: "completed",
			decision: { route: "edit", confidence: 0.2, reasons: [], riskFlags: [] },
		}), { route: "plan", fallbackReason: "pilot_router confidence is below 0.7" });
		assert.deepEqual(resolvePilotRoute({
			version: 1,
			requestId: "failure",
			status: "failed",
			error: "unavailable",
		}), { route: "plan", fallbackReason: "pilot_router failed" });
	});

	test("honors a shorter bridge deadline instead of the caller default", async () => {
		const events = new Events();
		events.on(PILOT_ROUTER_REQUEST_EVENT, (value) => {
			const request = value as { requestId: string };
			events.emit(PILOT_ROUTER_STARTED_EVENT, { version: 1, requestId: request.requestId, timeoutMs: 1 });
		});
		const outcome = await Promise.race([
			requestPilotRoute({ events, prompt: "route this", timeoutMs: 50 }).then(() => "completed", () => "timed_out"),
			new Promise<string>((resolve) => setTimeout(() => resolve("still_waiting"), 10)),
		]);
		assert.equal(outcome, "timed_out");
	});

	test("cancels an unavailable request without waiting for its normal timeout", async () => {
		const events = new Events();
		let cancelled = false;
		events.on(PILOT_ROUTER_CANCEL_EVENT, () => { cancelled = true; });
		await assert.rejects(
			requestPilotRoute({ events, prompt: "route this", availabilityTimeoutMs: 1, timeoutMs: 20 }),
			/pilot_router unavailable/,
		);
		assert.equal(cancelled, true);
	});
});
