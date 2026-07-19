import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";

import { createBtwUsageEntry, resolveBtwCandidates } from "../lib/btw-route.ts";

function model(provider: string, id: string, maxTokens = 4096, input: ("text" | "image")[] = ["text"]): Model<Api> {
	return {
		provider, id, name: id, api: "openai-responses", baseUrl: "https://example.invalid", reasoning: true,
		input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens,
	} as Model<Api>;
}

describe("resolveBtwCandidates", () => {
	it("preserves current-model behavior without an auxiliary route", () => {
		const current = model("main", "expensive", 1000);
		const candidates = resolveBtwCandidates({
			route: undefined,
			current,
			legacyThinking: "minimal",
			legacyMaxOutputTokens: 2000,
			find: () => undefined,
		});
		assert.equal(candidates.length, 1);
		assert.equal(candidates[0]!.model, current);
		assert.equal(candidates[0]!.maxOutputTokens, 1000);
		assert.equal(candidates[0]!.auxiliary, false);
	});

	it("resolves explicit and current fallback models without duplicates", () => {
		const current = model("main", "expensive");
		const mini = model("openai", "family/mini", 512);
		const candidates = resolveBtwCandidates({
			route: {
				model: "openai/family/mini",
				thinking: "low",
				timeoutMs: 30_000,
				maxOutputTokens: 2000,
				fallbackModels: ["openai/family/mini", "current", "bad"],
			},
			current,
			legacyThinking: "minimal",
			legacyMaxOutputTokens: 1000,
			find: (provider, id) => provider === "openai" && id === "family/mini" ? mini : undefined,
		});
		assert.deepEqual(candidates.map((candidate) => `${candidate.model.provider}/${candidate.model.id}`), ["openai/family/mini", "main/expensive"]);
		assert.deepEqual(candidates.map((candidate) => candidate.fallbackIndex), [0, 1]);
		assert.equal(candidates[0]!.maxOutputTokens, 512);
		assert.equal(candidates[0]!.auxiliary, true);
	});

	it("creates a payload-free canonical usage event", () => {
		const candidate = resolveBtwCandidates({
			route: undefined,
			current: model("main", "expensive"),
			legacyThinking: "minimal",
			legacyMaxOutputTokens: 1000,
			find: () => undefined,
		})[0]!;
		const entry = createBtwUsageEntry(candidate, "ok", 100, 150, {
			input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		});
		assert.equal(entry.task, "btw");
		assert.equal(entry.executor, "session");
		assert.equal(entry.durationMs, 50);
		assert.equal(Object.hasOwn(entry, "prompt"), false);
		assert.equal(Object.hasOwn(entry, "response"), false);
	});
});
