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

	it("reprices each message using its own provider/model without mutating stored usage", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", provider: "a", model: "same", usage: { input: 1_000_000, output: 100_000, cacheRead: 200_000, cacheWrite: 50_000, cost: { total: 0 } } } },
			{ type: "message", message: { role: "assistant", provider: "b", model: "same", usage: { input: 1_000_000, cost: { total: 99 } } } },
			{ type: "message", message: { role: "assistant", provider: "missing", model: "old", usage: { cost: { total: 0.5 } } } },
		];
		const before = structuredClone(entries);
		const findModel = (provider: string, _id: string) => provider === "missing" ? undefined : ({
			cost: { input: provider === "a" ? 2 : 0, output: 10, cacheRead: 0.5, cacheWrite: 4 },
		} as any);
		assert.ok(Math.abs(aggregateSessionUsage(entries, findModel).cost - 3.8) < 1e-9);
		assert.deepEqual(entries, before);
	});

	it("ignores auxiliary ledger entries", () => {
		const entries = [{
			type: "custom",
			customType: "terrific-pi:auxiliary-usage-v1",
			data: {
				version: 1,
				id: "aux-1",
				task: "title",
				executor: "call",
				provider: "openai",
				model: "gpt-5.4-mini",
				thinking: "off",
				status: "ok",
				fallbackIndex: 0,
				startedAt: 1,
				durationMs: 10,
				usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0.01 } },
			},
		}];
		assert.deepEqual(aggregateSessionUsage(entries), {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			cost: 0,
		});
	});
});
