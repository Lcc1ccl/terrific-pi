import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveAll } from "../lib/model-resolution.ts";

describe("model resolution", () => {
	test("ready/approximate/blocked", () => {
		const rows = resolveAll(
			[
				{ agent: "research-analyst", requested: "grok4.5", thinking: "high" },
				{ agent: "product-architect", requested: "5.6-sol-max" },
				{ agent: "interface-designer", requested: "fable 5-max" },
			],
			[
				{ provider: "grok", id: "grok-4.5" },
				{ provider: "openai", id: "gpt-5.6-sol" },
			],
		);
		assert.equal(rows[0]?.status, "ready");
		assert.equal(rows[1]?.status, "approximate");
		assert.equal(rows[2]?.status, "blocked");
	});
});
