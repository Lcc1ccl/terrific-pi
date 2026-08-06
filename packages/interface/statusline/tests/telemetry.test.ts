import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TurnTelemetryTracker } from "../lib/telemetry.ts";

function message(output = 20, input = 50, total = input + output, cost = total * 0.000004) {
	return {
		role: "assistant" as const,
		usage: {
			input,
			output,
			totalTokens: total,
			cost: { total: cost },
		},
	};
}

function update(msg: ReturnType<typeof message>) {
	return {
		type: "message_update" as const,
		message: msg,
		assistantMessageEvent: { type: "text_delta", delta: "x" },
	};
}

function completeTurn(
	tracker: TurnTelemetryTracker,
	msg: ReturnType<typeof message>,
	setNow: (value: number) => void,
	start: number,
	end: number,
): void {
	setNow(start);
	tracker.handle({ type: "turn_start" });
	tracker.handle({ type: "message_start", message: msg });
	setNow(start + 100);
	tracker.handle(update(msg));
	setNow(start + 200);
	tracker.handle(update(msg));
	setNow(end);
	tracker.handle({ type: "message_end", message: msg });
	tracker.handle({ type: "turn_end" });
}

function settleUsage(usage: {
	input?: number;
	output?: number;
	totalTokens?: number;
	cost?: { total?: number };
}) {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const msg = { role: "assistant" as const, usage };
	tracker.handle({ type: "agent_start" });
	tracker.handle({ type: "turn_start" });
	tracker.handle({ type: "message_start", message: msg });
	now = 100;
	tracker.handle({
		type: "message_update",
		message: msg,
		assistantMessageEvent: { type: "text_delta", delta: "x" },
	});
	now = 500;
	tracker.handle({ type: "message_end", message: msg });
	tracker.handle({ type: "turn_end" });
	return tracker.handle({ type: "agent_settled" });
}

describe("TurnTelemetryTracker", () => {
	it("emits only one aggregate snapshot when an agent run settles", () => {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const setNow = (value: number) => { now = value; };
		tracker.handle({ type: "agent_start" });
		completeTurn(tracker, message(20, 50), setNow, 0, 500);
		completeTurn(tracker, message(30, 100), setNow, 10_500, 11_000);
		assert.equal(tracker.getLastSettled(), undefined);
		now = 11_100;
		const settled = tracker.handle({ type: "agent_settled" });
		assert.equal(settled?.tps, 50);
		assert.equal(settled?.measurementMs, 1_000);
		assert.equal(settled?.inputTokens, 150);
		assert.equal(settled?.outputTokens, 50);
		assert.equal(settled?.totalMs, 11_100);
		assert.equal(settled?.usageAvailable, true);
		assert.equal(tracker.handle({ type: "agent_settled" }), undefined);
		assert.deepEqual(tracker.getLastSettled(), settled);
	});

	it("measures non-streamed messages and meaningful deltas only", () => {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const msg = message();
		tracker.handle({ type: "agent_start" });
		tracker.handle({ type: "turn_start" });
		now = 100;
		tracker.handle({ type: "message_start", message: msg });
		tracker.handle({ type: "message_update", message: msg, assistantMessageEvent: { type: "start" } });
		now = 5_000;
		tracker.handle({ type: "message_end", message: msg });
		tracker.handle({ type: "turn_end" });
		const settled = tracker.handle({ type: "agent_settled" });
		assert.equal(settled?.ttftMs, 5_000);
		assert.equal(settled?.tps, 4);
	});

	it("counts stalls but excludes tool gaps from generation time", () => {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const first = message(20, 10);
		const second = message(20, 10);
		tracker.handle({ type: "agent_start" });
		tracker.handle({ type: "turn_start" });
		tracker.handle({ type: "message_start", message: first });
		now = 100;
		tracker.handle(update(first));
		now = 1_200;
		tracker.handle(update(first));
		now = 1_500;
		tracker.handle({ type: "message_end", message: first });
		tracker.handle({ type: "turn_end" });
		now = 11_500;
		tracker.handle({ type: "turn_start" });
		tracker.handle({ type: "message_start", message: second });
		now = 11_600;
		tracker.handle(update(second));
		now = 12_000;
		tracker.handle({ type: "message_end", message: second });
		tracker.handle({ type: "turn_end" });
		const settled = tracker.handle({ type: "agent_settled" });
		assert.equal(settled?.generationMs, 2_000);
		assert.equal(settled?.tps, 20);
		assert.equal(settled?.stallCount, 1);
		assert.equal(settled?.stallMs, 1_100);
	});

	it("derives each run metric only from its required usage fields", () => {
		const tokensOnly = settleUsage({ input: 10, output: 20 });
		assert.equal(tokensOnly?.inputTokens, 10);
		assert.equal(tokensOnly?.outputTokens, 20);
		assert.equal(tokensOnly?.tps, 40);
		assert.equal(tokensOnly?.totalTokens, null);
		assert.equal(tokensOnly?.costUsd, null);
		assert.equal(tokensOnly?.rateUsdPerMTokens, null);
		assert.equal(tokensOnly?.usageAvailable, true);

		const rateWithoutInput = settleUsage({
			output: 20,
			totalTokens: 30,
			cost: { total: 0.00012 },
		});
		assert.equal(rateWithoutInput?.inputTokens, null);
		assert.equal(rateWithoutInput?.outputTokens, 20);
		assert.equal(rateWithoutInput?.tps, 40);
		assert.equal(rateWithoutInput?.rateUsdPerMTokens, 4);
		assert.equal(rateWithoutInput?.usageAvailable, false);
	});

	it("keeps finite fields while marking malformed fields unavailable", () => {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const setNow = (value: number) => { now = value; };
		tracker.handle({ type: "agent_start" });
		completeTurn(tracker, message(Number.NaN, 10, Number.POSITIVE_INFINITY), setNow, 0, 500);
		const settled = tracker.handle({ type: "agent_settled" });
		assert.equal(settled?.usageAvailable, false);
		assert.equal(settled?.tps, null);
		assert.equal(settled?.inputTokens, 10);
		assert.equal(settled?.outputTokens, null);
	});

	it("reset clears transient and settled state for abort/tree/compact/reload", () => {
		for (const reason of ["abort", "tree", "compact", "reload"] as const) {
			let now = 0;
			const tracker = new TurnTelemetryTracker(() => now);
			const setNow = (value: number) => { now = value; };
			tracker.handle({ type: "agent_start" });
			completeTurn(tracker, message(), setNow, 0, 500);
			tracker.reset(reason);
			assert.equal(tracker.handle({ type: "agent_settled" }), undefined, reason);
			assert.equal(tracker.getLastSettled(), undefined, reason);
		}
	});

	it("does not leak data across ten generations", () => {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const setNow = (value: number) => { now = value; };
		for (let generation = 1; generation <= 10; generation++) {
			tracker.handle({ type: "agent_start" });
			completeTurn(tracker, message(generation, generation * 2), setNow, now, now + 100);
			const settled = tracker.handle({ type: "agent_settled" });
			assert.equal(settled?.outputTokens, generation);
			assert.equal(settled?.inputTokens, generation * 2);
		}
	});
});
