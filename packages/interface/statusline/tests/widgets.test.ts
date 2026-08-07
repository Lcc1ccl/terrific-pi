import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import {
	buildWidgetSegments,
	EXCLUDED_PROGRESS_KEYS,
	EXCLUDED_TOOL_ACTIVITY_NAMES,
	joinExtensionProgress,
	PROCESS_STATUS_KEY,
	TASKBOARD_STATUS_KEY,
	resolveRunState,
	runStateForAssistantEvent,
	shouldTrackToolActivity,
} from "../lib/widgets.ts";
import type { StatusSnapshot, WidgetId, WidgetLines } from "../lib/types.ts";

function line1(widgets: readonly WidgetId[]): WidgetLines {
	return { line0: [], line1: [...widgets], line2: [], line3: [], line4: [] };
}

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
				"model",
				"fast",
				"path",
				"session",
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
				"gpt-5 high",
				"",
				"demo",
				"🔼 1.5K · 🔽 800",
				"🎯 66.7%",
				"$0.42",
				"🪟 [██████░░░░] 60%",
				"⑂ main",
				"+12 -3",
				"task 1/2",
				"🕒 12s / 1m45s",
				"Ready",
			],
		);
		const path = segments.find((segment) => segment.id === "path");
		assert.equal(path?.text, "📁 /home/user/proj");
	});

	it("builds default-oriented segments with new p0 widgets", () => {
		const segments = buildWidgetSegments(baseSnapshot, DEFAULT_CONFIG);
		const texts = segments.map((segment) => segment.text);
		assert.ok(texts.some((text) => text.includes("demo")));
		assert.ok(texts.some((text) => text.includes("$0.42")));
		assert.ok(texts.some((text) => text.includes("🎯 ") && text.includes("%")));
		assert.ok(texts.some((text) => text.includes("ctx") || text.includes("%")));
		assert.ok(texts.includes("Ready"));
	});

	it("honors widget order and hides empty optional widgets", () => {
		const segments = buildWidgetSegments(
			{ ...baseSnapshot, sessionName: undefined, branch: null, branchDiff: undefined, progress: undefined },
			{
				...DEFAULT_CONFIG,
				lines: line1(["session", "branch", "cost", "state"]),
			},
		);
		assert.deepEqual(
			segments.map((segment) => segment.text),
			["$0.42", "Ready"],
		);
	});

	it("truncates long session names for HUD space", () => {
		const segments = buildWidgetSegments(
			{ ...baseSnapshot, sessionName: "Investigate why statusline session titles overflow stacked HUD rows" },
			{ ...DEFAULT_CONFIG, lines: line1(["session"]) },
		);
		assert.deepEqual(segments.map((segment) => segment.text), ["Investigate why statusl…"]);
	});

	it("hides zero cost", () => {
		const segments = buildWidgetSegments(
			{ ...baseSnapshot, cost: 0 },
			{ ...DEFAULT_CONFIG, lines: line1(["cost", "state"]) },
		);
		assert.deepEqual(
			segments.map((segment) => segment.text),
			["Ready"],
		);
	});

	it("keeps auxiliary usage out of footer tokens and cost", () => {
		const legacySnapshot = {
			...baseSnapshot,
			auxUsage: {
				input: 3_700,
				output: 900,
				unsplit: 0,
				tokens: 4_600,
				cost: 0.03,
				hasUnknownUsage: true,
				hasUnknownCost: true,
			},
		};
		const segments = buildWidgetSegments(
			legacySnapshot,
			{ ...DEFAULT_CONFIG, lines: line1(["tokens", "cost"]), iconMode: "plain" },
		);
		assert.deepEqual(segments.map((segment) => segment.text), ["in 1.5K · out 800", "$0.42"]);
	});

	it("renders fast independently and hides it when inactive", () => {
		const active = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			lines: line1(["fast", "progress"]),
		});
		assert.deepEqual(active.map((segment) => segment.text), ["", "task 1/2"]);
		assert.equal(active[0]?.parts?.[0]?.tone, "warn");

		const inactive = buildWidgetSegments(
			{ ...baseSnapshot, fast: undefined },
			{ ...DEFAULT_CONFIG, lines: line1(["fast"]) },
		);
		assert.deepEqual(inactive, []);
	});

	it("keeps input and output tokens in one atomic segment", () => {
		const segments = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			lines: line1(["tokens"]),
		});
		assert.deepEqual(
			segments.map((segment) => segment.text),
			["🔼 1.5K · 🔽 800"],
		);
	});

	it("renders plain token labels without changing numbers", () => {
		const segments = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			lines: line1(["tokens", "cache", "fast", "branch"]),
			iconMode: "plain",
		});
		assert.deepEqual(
			segments.map((segment) => segment.text),
			["in 1.5K · out 800", "cache 66.7%", "fast", "main"],
		);
	});

	it("uses OMP-like category tones without hard-coded colors", () => {
		const metadata = buildWidgetSegments(
			{ ...baseSnapshot, branch: "feature" },
			{ ...DEFAULT_CONFIG, lines: line1(["model", "path", "branch", "cost", "context"]) },
		);
		assert.equal(metadata.find((segment) => segment.id === "model")?.parts?.[0]?.tone, "model");
		assert.ok(metadata.find((segment) => segment.id === "path")?.parts?.every((part) => part.tone === "active"));
		assert.ok(metadata.find((segment) => segment.id === "branch")?.parts?.every((part) => part.tone === "branch"));
		assert.ok(metadata.find((segment) => segment.id === "cost")?.parts?.every((part) => part.tone === "cost"));

		for (const [runState, expectedTone] of [
			["Ready", "dim"],
			["Working", "active"],
			["Thinking", "thinkingHigh"],
			["Waiting", "muted"],
		] as const) {
			const [state] = buildWidgetSegments(
				{ ...baseSnapshot, runState },
				{ ...DEFAULT_CONFIG, lines: line1(["state"]) },
			);
			assert.equal(state?.parts?.[0]?.tone, expectedTone);
		}
	});

	it("colors mode badges by permission risk", () => {
		for (const [mode, tone] of [
			["ASK", "dim"],
			["PLAN", "muted"],
			["EDIT", "value"],
			["AUTO", "thinkingLow"],
		] as const) {
			const [segment] = buildWidgetSegments(
				{ ...baseSnapshot, mode },
				{ ...DEFAULT_CONFIG, lines: line1(["mode"]) },
			);
			assert.equal(segment?.text, mode);
			assert.equal(segment?.parts?.[0]?.tone, tone);
		}
	});

	it("renders main and master as branch text instead of home", () => {
		const main = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			lines: line1(["branch"]),
		});
		const master = buildWidgetSegments(
			{ ...baseSnapshot, branch: "master" },
			{ ...DEFAULT_CONFIG, lines: line1(["branch"]) },
		);
		assert.deepEqual(main.map((segment) => segment.text), ["⑂ main"]);
		assert.deepEqual(master.map((segment) => segment.text), ["⑂ master"]);
	});

	it("shows an unavailable marker when context usage is missing or unknown after compaction", () => {
		for (const widget of ["context", "contextBar"] as const) {
			for (const context of [
				undefined,
				{ tokens: null, contextWindow: 100_000, percent: null },
			]) {
				const segments = buildWidgetSegments(
					{ ...baseSnapshot, context },
					{ ...DEFAULT_CONFIG, lines: line1([widget]) },
				);
				assert.deepEqual(segments.map((segment) => segment.text), ["🪟 ?"]);
			}
		}
	});

	it("hides branch changes when the diff is empty", () => {
		const segments = buildWidgetSegments(
			{ ...baseSnapshot, branchDiff: { additions: 0, deletions: 0 } },
			{ ...DEFAULT_CONFIG, lines: line1(["branchDiff"]) },
		);
		assert.deepEqual(segments, []);
	});

	it("renders duration pair", () => {
		const segments = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			lines: line1(["duration", "state"]),
		});
		assert.deepEqual(
			segments.map((segment) => segment.text),
			["🕒 12s / 1m45s", "Ready"],
		);
	});

	it("renders quota loading and first-load error states", () => {
		for (const [quotaStatus, expected] of [
			["loading", "Usage …"],
			["error", "Usage unavailable"],
		] as const) {
			const segments = buildWidgetSegments(
				{ ...baseSnapshot, quotaStatus },
				{ ...DEFAULT_CONFIG, lines: line1(["quota"]) },
			);
			assert.deepEqual(segments.map((segment) => segment.text), [expected]);
		}
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
				lines: line1(["quota", "environment", "toolActivity"]),
				toolActivityMode: "detailed",
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
		assert.equal(segments[1]?.accent, "dim");
		assert.ok(segments[2]?.parts?.some((part) => part.tone === "label"));
	});

	it("uses abbreviated labels when minimal is enabled", () => {
		const segments = buildWidgetSegments(baseSnapshot, {
			...DEFAULT_CONFIG,
			lines: line1(["tokens", "cache", "cost", "context", "duration", "contextBar"]),
			minimal: true,
			iconMode: "plain",
			contextMode: "remaining",
		});
		const texts = segments.map((segment) => segment.text);
		assert.equal(texts[0], "in 1.5K · out 800");
		assert.equal(texts[1], "CH 66.7%");
		assert.equal(texts[2], "$0.42");
		assert.equal(texts[3], "ctx 60% left");
		assert.equal(texts[4], "t 12s/1m45s");
		assert.equal(texts[5], "ctx [██████░░░░] 60%");
	});
});

describe("runStateForAssistantEvent", () => {
	it("maps reasoning and generation events to actual LLM states", () => {
		assert.equal(runStateForAssistantEvent("thinking_delta"), "Thinking");
		assert.equal(runStateForAssistantEvent("text_delta"), "Working");
		assert.equal(runStateForAssistantEvent("toolcall_delta"), "Working");
		assert.equal(runStateForAssistantEvent("done"), undefined);
	});

	it("uses taskboard waiting state with process compatibility fallback", () => {
		assert.equal(resolveRunState("Ready", new Map([[TASKBOARD_STATUS_KEY, "waiting"]])), "Waiting");
		assert.equal(resolveRunState("Ready", new Map([[PROCESS_STATUS_KEY, "blocked"]])), "Waiting");
		assert.equal(resolveRunState("Thinking", new Map([[TASKBOARD_STATUS_KEY, "waiting"]])), "Thinking");
		assert.equal(resolveRunState("Ready", new Map([[TASKBOARD_STATUS_KEY, "running"]])), "Ready");
		assert.equal(
			resolveRunState("Ready", new Map([[PROCESS_STATUS_KEY, "waiting"], [TASKBOARD_STATUS_KEY, "running"]])),
			"Ready",
		);
		assert.ok(EXCLUDED_PROGRESS_KEYS.has(TASKBOARD_STATUS_KEY));
		assert.ok(EXCLUDED_PROGRESS_KEYS.has(PROCESS_STATUS_KEY));
	});
});

describe("shouldTrackToolActivity", () => {
	it("excludes process metadata while retaining business tools", () => {
		assert.deepEqual([...EXCLUDED_TOOL_ACTIVITY_NAMES], ["process_update"]);
		assert.equal(shouldTrackToolActivity("process_update"), false);
		assert.equal(shouldTrackToolActivity("read"), true);
		assert.equal(shouldTrackToolActivity("custom_tool"), true);
	});
});

describe("joinExtensionProgress", () => {
	it("filters dedicated statuses and strips ANSI and OSC controls", () => {
		const statuses = new Map([
			["ponytail", "\x1b[32mponytail: LITE\x1b[39m"],
			["fast", ""],
			["task", "\x1b]8;;https://example.com\x07step 1/2\x1b]8;;\x07"],
			["other", "  building  "],
		]);
		assert.equal(joinExtensionProgress(statuses), "step 1/2 building");
	});

	it("returns undefined when only dedicated or empty statuses remain", () => {
		assert.equal(joinExtensionProgress(new Map([["ponytail", "ponytail: LITE"]])), undefined);
		assert.equal(joinExtensionProgress(new Map([["mode", "PLAN"]])), undefined);
		assert.equal(joinExtensionProgress(new Map([["fast", ""]])), undefined);
		assert.equal(joinExtensionProgress(new Map([["auxiliary", "aux web_research · grok-4.5"]])), undefined);
		assert.equal(joinExtensionProgress(new Map([["task", "   "]])), undefined);
		assert.ok(EXCLUDED_PROGRESS_KEYS.has("auxiliary"));
	});
});
