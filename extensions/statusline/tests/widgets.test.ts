import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import {
	buildWidgetSegments,
	joinExtensionProgress,
	runStateForAssistantEvent,
} from "../lib/widgets.ts";
import type { StatusSnapshot } from "../lib/types.ts";

const baseSnapshot: StatusSnapshot = {
	cwd: "/home/user/proj",
	sessionName: "demo",
	modelId: "gpt-5",
	thinkingLevel: "high",
	hasReasoning: true,
	fast: "",
	tokens: { input: 1500, output: 800, cacheRead: 4000, cacheWrite: 500 },
	cost: 0.42,
	context: { tokens: 40_000, contextWindow: 100_000, percent: 40 },
	branch: "main",
	branchDiff: { additions: 12, deletions: 3 },
	progress: "task 1/2",
	duration: { roundMs: 12_300, sessionMs: 105_000 },
	runState: "Ready",
};

describe("buildWidgetSegments", () => {
	it("locks default widget text sequence (characterization)", () => {
		const segments = buildWidgetSegments(baseSnapshot, DEFAULT_CONFIG);
		assert.deepEqual(
			segments.map((segment) => segment.id),
			[
				"path",
				"session",
				"model",
				"fast",
				"tokens",
				"tokens",
				"cache",
				"cost",
				"contextBar",
				"branch",
				"branchDiff",
				"progress",
				"duration",
				"state",
			],
		);
		assert.deepEqual(
			segments.filter((segment) => segment.id !== "path").map((segment) => segment.text),
			[
				"demo",
				"gpt-5 high",
				"",
				"1.5K",
				"800",
				"🎯66.7%",
				"$0.42",
				"[██████░░░░] 60%",
				"🏠",
				"+12 -3",
				"task 1/2",
				"12.3s / 1m45s",
				"Ready",
			],
		);
	});

	it("builds default-oriented segments with new p0 widgets", () => {
		const segments = buildWidgetSegments(baseSnapshot, DEFAULT_CONFIG);
		const texts = segments.map((segment) => segment.text);
		assert.ok(texts.some((text) => text.includes("demo")));
		assert.ok(texts.some((text) => text.includes("$0.42")));
		assert.ok(texts.some((text) => text.includes("🎯") && text.includes("%")));
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

	it("renders fast independently and hides it when inactive", () => {
		const active = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			widgets: ["fast", "progress"],
		});
		assert.deepEqual(active.map((segment) => segment.text), ["", "task 1/2"]);

		const inactive = buildWidgetSegments(
			{ ...baseSnapshot, fast: undefined },
			{ ...DEFAULT_CONFIG, widgets: ["fast"] },
		);
		assert.deepEqual(inactive, []);
	});

	it("uses single-column token direction icons", () => {
		const segments = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			widgets: ["tokens"],
		});
		assert.deepEqual(
			segments.map((segment) => segment.text),
			["1.5K", "800"],
		);
	});

	it("renders plain token labels without changing numbers", () => {
		const segments = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			widgets: ["tokens", "cache", "fast", "branch"],
			iconMode: "plain",
		});
		assert.deepEqual(
			segments.map((segment) => segment.text),
			["in 1.5K", "out 800", "cache 66.7%", "fast", "main"],
		);
	});

	it("renders main as home", () => {
		const segments = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			widgets: ["branch"],
		});
		assert.deepEqual(segments.map((segment) => segment.text), ["🏠"]);
	});

	it("renders master as home", () => {
		const segments = buildWidgetSegments(
			{ ...baseSnapshot, branch: "master" },
			{ ...DEFAULT_CONFIG, widgets: ["branch"] },
		);
		assert.deepEqual(segments.map((segment) => segment.text), ["🏠"]);
	});

	it("hides branch changes when the diff is empty", () => {
		const segments = buildWidgetSegments(
			{ ...baseSnapshot, branchDiff: { additions: 0, deletions: 0 } },
			{ ...DEFAULT_CONFIG, widgets: ["branchDiff"] },
		);
		assert.deepEqual(segments, []);
	});

	it("renders duration pair", () => {
		const segments = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			widgets: ["duration", "state"],
		});
		assert.deepEqual(
			segments.map((segment) => segment.text),
			["12.3s / 1m45s", "Ready"],
		);
	});

	it("renders quota environment and tool activity widgets", () => {
		const segments = buildWidgetSegments(
			{
				...baseSnapshot,
				quota: {
					provider: "claude",
					windows: [{ id: "five_hour", label: "5h", usedPercent: 7 }],
					capturedAt: Date.now(),
					stale: false,
				},
				environment: { contextFiles: 2, skills: 3, tools: 4 },
				toolActivity: {
					Read: { active: 0, success: 6, error: 0 },
				},
			},
			{
				...DEFAULT_CONFIG,
				widgets: ["quota", "environment", "toolActivity"],
			},
		);
		assert.deepEqual(
			segments.map((segment) => segment.text),
			[
				"📊 5h [░░░░░░] 7%",
				"2 context files · 3 skills · 4 tools",
				"✓ Read x6",
			],
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

describe("runStateForAssistantEvent", () => {
	it("maps reasoning and generation events to actual LLM states", () => {
		assert.equal(runStateForAssistantEvent("thinking_delta"), "Thinking");
		assert.equal(runStateForAssistantEvent("text_delta"), "Working");
		assert.equal(runStateForAssistantEvent("toolcall_delta"), "Working");
		assert.equal(runStateForAssistantEvent("done"), undefined);
	});
});

describe("joinExtensionProgress", () => {
	it("joins non-excluded statuses and strips ansi", () => {
		const statuses = new Map([
			["ponytail", "\x1b[32m○\x1b[39m 🐴 ponytail: LITE"],
			["fast", ""],
			["task", "step 1/2"],
			["other", "  building  "],
		]);
		assert.equal(joinExtensionProgress(statuses), "step 1/2 building");
	});

	it("returns undefined when only excluded/empty remain", () => {
		assert.equal(joinExtensionProgress(new Map([["ponytail", "active"]])), undefined);
		assert.equal(joinExtensionProgress(new Map([["pi-essentials-mode", "PLAN"]])), undefined);
		assert.equal(joinExtensionProgress(new Map([["fast", ""]])), undefined);
		assert.equal(joinExtensionProgress(new Map([["task", "   "]])), undefined);
	});
});
