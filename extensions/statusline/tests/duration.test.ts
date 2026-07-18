import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentDurationTracker, formatDuration, formatDurationPair } from "../lib/duration.ts";

describe("formatDuration", () => {
	it("formats sub-minute and longer spans", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(1_200), "1.2s");
		assert.equal(formatDuration(4_000), "4s");
		assert.equal(formatDuration(65_000), "1m05s");
		assert.equal(formatDuration(3_725_000), "1h02m05s");
	});
});

describe("formatDurationPair", () => {
	it("joins round and session", () => {
		assert.equal(formatDurationPair(12_300, 105_000), "12.3s / 1m45s");
		assert.equal(formatDurationPair(12_300, 105_000, true), "12.3s/1m45s");
	});
});

describe("AgentDurationTracker", () => {
	it("keeps counting while a child process runs until the agent settles", () => {
		const tracker = new AgentDurationTracker();
		tracker.startRound(1_000);
		assert.deepEqual(tracker.snapshot(9_000), { roundMs: 8_000, sessionMs: 8_000 });
		tracker.endRound(9_000);
		assert.deepEqual(tracker.snapshot(12_000), { roundMs: 8_000, sessionMs: 8_000 });
	});

	it("accumulates agent rounds without counting idle time", () => {
		const tracker = new AgentDurationTracker();
		tracker.startRound(1_000);
		tracker.endRound(7_000);
		assert.deepEqual(tracker.snapshot(9_000), { roundMs: 6_000, sessionMs: 6_000 });

		tracker.startRound(10_000);
		assert.deepEqual(tracker.snapshot(10_000), { roundMs: 0, sessionMs: 6_000 });
		tracker.endRound(12_000);
		assert.deepEqual(tracker.snapshot(20_000), { roundMs: 2_000, sessionMs: 8_000 });
	});

	it("does not reset the round on a low-level retry", () => {
		const tracker = new AgentDurationTracker();
		tracker.startRound(1_000);
		tracker.startRound(5_000);
		assert.deepEqual(tracker.snapshot(7_000), { roundMs: 6_000, sessionMs: 6_000 });
	});

	it("reset clears all counters", () => {
		const tracker = new AgentDurationTracker();
		tracker.startRound(0);
		tracker.reset();
		assert.deepEqual(tracker.snapshot(100), { roundMs: 0, sessionMs: 0 });
		assert.equal(tracker.isRunning(), false);
	});
});
