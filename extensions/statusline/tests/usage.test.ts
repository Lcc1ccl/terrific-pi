import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregateSessionUsage } from "../lib/usage.ts";

describe("aggregateSessionUsage", () => {
	it("sums assistant usage on the active branch only", () => {
		const totals = aggregateSessionUsage([
			{
				type: "message",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 200,
						cacheWrite: 20,
						cost: { total: 0.1 },
					},
				},
			},
			{
				type: "message",
				message: {
					role: "user",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: {
						input: 40,
						output: 10,
						cacheRead: 80,
						cacheWrite: 5,
						cost: { total: 0.05 },
					},
				},
			},
		]);

		assert.deepEqual(totals.tokens, {
			input: 140,
			output: 60,
			cacheRead: 280,
			cacheWrite: 25,
		});
		assert.ok(Math.abs(totals.cost - 0.15) < 1e-9);
	});
});
