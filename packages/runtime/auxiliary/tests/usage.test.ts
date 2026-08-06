import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	AUXILIARY_USAGE_ENTRY_TYPE,
	ActiveTaskTracker,
	aggregateAuxiliaryUsage,
	isAuxiliaryUsageEntry,
} from "../lib/usage.ts";
import type { AuxiliaryUsageEntryV1 } from "../lib/types.ts";

function entry(overrides: Partial<AuxiliaryUsageEntryV1> = {}): AuxiliaryUsageEntryV1 {
	return {
		version: 1,
		id: "call-1",
		task: "text_summary",
		executor: "call",
		provider: "openai",
		model: "small",
		thinking: "off",
		status: "ok",
		fallbackIndex: 0,
		startedAt: 1,
		durationMs: 10,
		usage: {
			input: 100,
			output: 20,
			cacheRead: 10,
			cacheWrite: 0,
			totalTokens: 130,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
		},
		...overrides,
	};
}

describe("auxiliary usage", () => {
	test("validates canonical entries and rejects payload-bearing impostors", () => {
		assert.equal(isAuxiliaryUsageEntry(entry()), true);
		assert.equal(isAuxiliaryUsageEntry({ ...entry(), prompt: "secret" }), false);
		assert.equal(isAuxiliaryUsageEntry({ ...entry(), version: 2 }), false);
	});

	test("aggregates only the supplied branch and preserves unknown cost", () => {
		const totals = aggregateAuxiliaryUsage([
			{ type: "custom", customType: AUXILIARY_USAGE_ENTRY_TYPE, data: entry() },
			{ type: "custom", customType: AUXILIARY_USAGE_ENTRY_TYPE, data: entry({ id: "call-2", usage: { ...entry().usage!, cost: undefined as never } }) },
			{ type: "custom", customType: "other", data: entry({ id: "ignored" }) },
		]);
		assert.equal(totals.calls, 2);
		assert.equal(totals.tokens, 260);
		assert.equal(totals.cost, 0.31);
		assert.equal(totals.hasUnknownCost, true);
	});
});

describe("ActiveTaskTracker", () => {
	test("renders one task, a count, and clears after completion", () => {
		const statuses: Array<string | undefined> = [];
		const tracker = new ActiveTaskTracker((value) => statuses.push(value));
		const first = tracker.start("compression", "gpt-mini");
		const second = tracker.start("title_generation", "gpt-mini");
		tracker.finish(first);
		tracker.finish(second);
		assert.deepEqual(statuses, ["aux compression · gpt-mini", "aux 2 tasks", "aux title_generation · gpt-mini", undefined]);
	});
});
