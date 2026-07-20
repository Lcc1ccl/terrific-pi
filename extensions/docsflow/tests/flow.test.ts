import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyContractOutcome, nextAction, resolveStageRunConfig } from "../lib/flow.ts";
import { emptyState } from "../lib/state.ts";

describe("docsflow nextAction", () => {
	test("linear stages without hermes gates", () => {
		let state = emptyState({ requirement: "x", completedStages: [] });
		assert.deepEqual(nextAction(state), { kind: "run", stage: "research" });

		state = emptyState({ requirement: "x", completedStages: ["research"] });
		assert.deepEqual(nextAction(state), { kind: "run", stage: "product" });

		state = emptyState({ requirement: "x", completedStages: ["research", "product"] });
		assert.deepEqual(nextAction(state), { kind: "run", stage: "interface" });

		state = emptyState({ requirement: "x", completedStages: ["research", "product", "interface"] });
		assert.deepEqual(nextAction(state), { kind: "run", stage: "delivery" });

		state = emptyState({ requirement: "x", completedStages: ["research", "product", "interface", "delivery"] });
		assert.deepEqual(nextAction(state), { kind: "ready" });
	});

	test("applies a stage model, thinking, and timeout override to the delegated run", () => {
		assert.deepEqual(resolveStageRunConfig(
			{ name: "research-analyst", description: "x", model: "grok/base", thinking: "medium", tools: [], skills: [], artifactAllowlist: [], filePath: "x", body: "x" },
			"research",
			{ research: { model: "openai/gpt-test", thinking: "high", timeoutMs: 45_000 } },
		), {
			model: "openai/gpt-test:high",
			timeoutMs: 45_000,
		});
	});

	test("keeps the profile thinking level when a stage only overrides its model", () => {
		assert.deepEqual(resolveStageRunConfig(
			{ name: "research-analyst", description: "x", model: "grok/base", thinking: "medium", tools: [], skills: [], artifactAllowlist: [], filePath: "x", body: "x" },
			"research",
			{ research: { model: "openai/gpt-test", timeoutMs: 45_000 } },
		), {
			model: "openai/gpt-test:medium",
			timeoutMs: 45_000,
		});
	});

	test("marks only completed contracts as completed stages", () => {
		const state = emptyState({ completedStages: ["research"] });
		applyContractOutcome(state, "product", "completed", "Product ready");
		assert.deepEqual(state.completedStages, ["research", "product"]);
		assert.equal(state.status, "idle");
		assert.equal(state.lastError, undefined);
	});

	test("keeps blocked, needs-input, and failed stages retryable", () => {
		for (const [status, expected] of [
			["blocked", "blocked"],
			["needs_input", "blocked"],
			["failed", "failed"],
		] as const) {
			const state = emptyState({ completedStages: ["research"] });
			applyContractOutcome(state, "product", status, `status=${status}`);
			assert.deepEqual(state.completedStages, ["research"]);
			assert.equal(state.status, expected);
			assert.equal(state.currentStage, "product");
			assert.equal(state.lastError, `status=${status}`);
			assert.deepEqual(nextAction(state), { kind: "run", stage: "product" });
		}
	});
});
