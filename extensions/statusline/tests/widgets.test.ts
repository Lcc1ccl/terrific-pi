import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { buildWidgetSegments, joinExtensionProgress } from "../lib/widgets.ts";
import type { StatusSnapshot } from "../lib/types.ts";

const baseSnapshot: StatusSnapshot = {
	cwd: "/home/user/proj",
	sessionName: "demo",
	modelId: "gpt-5",
	thinkingLevel: "high",
	hasReasoning: true,
	tokens: { input: 1500, output: 800, cacheRead: 4000, cacheWrite: 500 },
	cost: 0.42,
	context: { tokens: 40_000, contextWindow: 100_000, percent: 40 },
	branch: "main",
	branchDiff: { additions: 12, deletions: 3 },
	progress: "task 1/2",
	runState: "Ready",
};

describe("buildWidgetSegments", () => {
	it("builds default-oriented segments with new p0 widgets", () => {
		const segments = buildWidgetSegments(baseSnapshot, DEFAULT_CONFIG);
		const texts = segments.map((segment) => segment.text);
		assert.ok(texts.some((text) => text.includes("demo")));
		assert.ok(texts.some((text) => text.includes("$0.42")));
		assert.ok(texts.some((text) => text.includes("↓") && text.includes("🎯")));
		assert.ok(texts.some((text) => text.includes("ctx") || text.includes("%")));
		assert.ok(texts.includes("Ready"));
	});

	it("honors widget order and hides empty optional widgets", () => {
		const segments = buildWidgetSegments(
			{ ...baseSnapshot, sessionName: undefined, branch: null, branchDiff: undefined, progress: undefined },
			{
				...DEFAULT_CONFIG,
				widgets: ["session", "branch", "cost", "state"],
			},
		);
		assert.deepEqual(
			segments.map((segment) => segment.text),
			["$0.42", "Ready"],
		);
	});

	it("hides zero cost", () => {
		const segments = buildWidgetSegments(
			{ ...baseSnapshot, cost: 0 },
			{ ...DEFAULT_CONFIG, widgets: ["cost", "state"] },
		);
		assert.deepEqual(
			segments.map((segment) => segment.text),
			["Ready"],
		);
	});

	it("uses minimal labels when enabled", () => {
		const segments = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			widgets: ["tokens", "cache", "cost", "context"],
			minimal: true,
			contextMode: "remaining",
		});
		const texts = segments.map((segment) => segment.text);
		assert.ok(texts.some((text) => text.includes("in") === false || /1\.5K.*0\.8K|↑|↓/.test(text) || text.includes("1.5K")));
		assert.ok(texts.includes("$0.42") || texts.includes("0.42"));
		assert.ok(texts.some((text) => text === "60%" || text.endsWith("%")));
	});
});

describe("joinExtensionProgress", () => {
	it("joins non-excluded statuses and strips ansi", () => {
		const statuses = new Map([
			["ponytail", "\x1b[32m○\x1b[39m 🐴 ponytail: LITE"],
			["task", "step 1/2"],
			["other", "  building  "],
		]);
		assert.equal(joinExtensionProgress(statuses), "step 1/2 building");
	});

	it("returns undefined when only excluded/empty remain", () => {
		assert.equal(joinExtensionProgress(new Map([["ponytail", "active"]])), undefined);
		assert.equal(joinExtensionProgress(new Map([["task", "   "]])), undefined);
	});
});
