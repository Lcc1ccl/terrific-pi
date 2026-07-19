import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	DELEGATION_RESPONSE_EVENT,
	DELEGATION_STARTED_EVENT,
	buildDocsDelegationRequest,
	delegateDocsAgent,
} from "../lib/delegate.ts";

class Bus {
	private handlers = new Map<string, Set<(value: unknown) => void>>();
	on(event: string, handler: (value: unknown) => void) {
		const set = this.handlers.get(event) ?? new Set();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}
	emit(event: string, value: unknown) {
		for (const handler of this.handlers.get(event) ?? []) handler(value);
	}
}

describe("delegate", () => {
	test("blocks mutation tools", () => {
		const req = buildDocsDelegationRequest({ requestId: "1", agent: "research-analyst", cwd: "/tmp", task: "t" });
		assert.ok(req.toolBudget.block.includes("write"));
	});
	test("waits for response", async () => {
		const bus = new Bus();
		const request = buildDocsDelegationRequest({ requestId: "r2", agent: "research-analyst", cwd: "/tmp", task: "t" });
		const pending = delegateDocsAgent({ events: bus, request, availabilityTimeoutMs: 1000 });
		bus.emit(DELEGATION_STARTED_EVENT, { version: 1, requestId: "r2" });
		bus.emit(DELEGATION_RESPONSE_EVENT, { version: 1, requestId: "r2", status: "completed", output: "{}" });
		const res = await pending;
		assert.equal(res.status, "completed");
	});
});
