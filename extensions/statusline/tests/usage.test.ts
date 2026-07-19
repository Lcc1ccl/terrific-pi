import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregateAuxiliaryUsage, aggregateSessionUsage } from "../lib/usage.ts";

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

	it("keeps canonical auxiliary usage separate from main totals", () => {
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
		}, {
			type: "custom",
			customType: "terrific-pi:auxiliary-usage-v1",
			data: {
				version: 1,
				id: "aux-2",
				task: "compression",
				executor: "call",
				provider: "openai",
				model: "gpt-5.4-mini",
				thinking: "low",
				status: "error",
				fallbackIndex: 0,
				startedAt: 2,
				durationMs: 20,
			},
		}];
		assert.deepEqual(aggregateSessionUsage(entries), {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			cost: 0,
		});
		assert.deepEqual(aggregateAuxiliaryUsage(entries), { calls: 2, tokens: 125, hasUnknownUsage: true });
	});

	it("ignores malformed or duplicate auxiliary entries", () => {
		const data = {
			version: 1, id: "same", task: "title", executor: "call", provider: "p", model: "m", thinking: "off",
			status: "ok", fallbackIndex: 0, startedAt: 1, durationMs: 1,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.1 } },
		};
		assert.deepEqual(aggregateAuxiliaryUsage([
			{ type: "custom", customType: "terrific-pi:auxiliary-usage-v1", data },
			{ type: "custom", customType: "terrific-pi:auxiliary-usage-v1", data },
			{ type: "custom", customType: "terrific-pi:auxiliary-usage-v1", data: { ...data, id: "bad", payload: "secret" } },
		]), { calls: 1, tokens: 2, cost: 0.1 });
	});
});
