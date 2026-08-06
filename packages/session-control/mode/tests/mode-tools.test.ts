import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseModeArg, toolsForMode, uniqueTools } from "../lib/mode-tools.ts";

describe("toolsForMode", () => {
	it("restricts ask and plan to read-only tools", () => {
		assert.deepEqual(toolsForMode("ask", ["read", "bash", "edit", "write", "aux_summarize", "web_research", "git_finalize"]), ["read", "grep", "find", "ls", "aux_summarize", "web_research"]);
		assert.deepEqual(toolsForMode("plan", ["read", "bash", "edit", "write", "aux_summarize", "web_research", "git_finalize"]), ["read", "grep", "find", "ls", "aux_summarize", "web_research"]);
	});

	it("restores baseline for edit and auto", () => {
		const baseline = ["read", "bash", "edit", "write", "questionnaire"];
		assert.deepEqual(toolsForMode("edit", baseline), uniqueTools(baseline));
		assert.deepEqual(toolsForMode("auto", baseline), uniqueTools(baseline));
	});
});

describe("parseModeArg", () => {
	it("parses known modes", () => {
		assert.equal(parseModeArg("ASK"), "ask");
		assert.equal(parseModeArg(" plan "), "plan");
		assert.equal(parseModeArg("nope"), undefined);
	});
});
