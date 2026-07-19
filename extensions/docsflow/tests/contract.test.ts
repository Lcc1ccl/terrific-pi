import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ContractError, parseContractFromText } from "../lib/contract.ts";

const sample = {
	status: "completed",
	summary: "ok",
	decisions: [],
	assumptions: [],
	evidence: [],
	unresolved: [],
	risks: [],
	recommended_next_step: "next",
	artifacts: [{ path: "00_Research.md", content: "# R\n" }],
	confidence: "medium",
};

describe("contract", () => {
	test("parses fenced json", () => {
		const c = parseContractFromText("```json\n" + JSON.stringify(sample) + "\n```");
		assert.equal(c.artifacts[0]?.path, "00_Research.md");
	});
	test("rejects empty artifacts", () => {
		assert.throws(() => parseContractFromText(JSON.stringify({ ...sample, artifacts: [] })), ContractError);
	});
});
