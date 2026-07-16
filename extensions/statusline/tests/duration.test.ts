import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDuration, formatDurationPair, LlmDurationTracker } from "../lib/duration.ts";

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

describe("LlmDurationTracker", () => {
	it("counts only closed + open assistant segments", () => {
		const tracker = new LlmDurationTracker();
		tracker.startRound(1_000);
		tracker.startSegment(1_000);
		tracker.stopSegment(4_000); // +3s
		tracker.startSegment(5_000); // tools idle gap ignored
		assert.deepEqual(tracker.snapshot(6_500), { roundMs: 4_500, sessionMs: 4_500 });
		tracker.stopSegment(7_000); // +2s more
		tracker.endRound(7_000);
		assert.deepEqual(tracker.snapshot(9_000), { roundMs: 5_000, sessionMs: 5_000 });

		tracker.startRound(10_000);
		assert.deepEqual(tracker.snapshot(10_000), { roundMs: 0, sessionMs: 5_000 });
		tracker.startSegment(10_000);
		tracker.stopSegment(12_000);
		tracker.endRound(12_000);
		assert.deepEqual(tracker.snapshot(20_000), { roundMs: 2_000, sessionMs: 7_000 });
	});

	it("reset clears all counters", () => {
		const tracker = new LlmDurationTracker();
		tracker.startRound(0);
		tracker.startSegment(0);
		tracker.stopSegment(5_000);
		tracker.reset();
		assert.deepEqual(tracker.snapshot(100), { roundMs: 0, sessionMs: 0 });
		assert.equal(tracker.isRunning(), false);
	});
});
