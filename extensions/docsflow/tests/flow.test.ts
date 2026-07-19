import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { nextAction } from "../lib/flow.ts";
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
});
