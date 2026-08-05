import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import {
	fitSegmentsToWidth,
	groupSegmentsBySemantics,
	plainVisibleWidth,
	renderStatusLine,
} from "../lib/render.ts";
import { buildWidgetSegments } from "../lib/widgets.ts";
import type { StatusSnapshot, StatuslineConfig, WidgetSegment } from "../lib/types.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TEST_THEME = { fg: (_color: string, text: string) => text };
const segments = [
	{ id: "path" as const, accent: "path" as const, text: "left" },
	{ id: "state" as const, accent: "state" as const, text: "right" },
];

function render(spacing: number, separator: "dot" | "bar" = "dot"): string {
	const config = {
		...DEFAULT_CONFIG,
		spacing,
		separator,
	};
	const line = renderStatusLine(segments, config, TEST_THEME, 200, (text) => text);
	return (Array.isArray(line) ? line[0]! : line).replace(ANSI_PATTERN, "");
}

const hudSnapshot: StatusSnapshot = {
	cwd: "/home/user/proj",
	sessionName: "demo",
	modelId: "gpt-5",
	thinkingLevel: "high",
	hasReasoning: true,
	mode: "EDIT",
	fast: "",
	tokens: { input: 12_500, output: 3_200, cacheRead: 4_000, cacheWrite: 500 },
	cost: 0.42,
	context: { tokens: 4_000, contextWindow: 100_000, percent: 4 },
	branch: "main",
	branchDiff: { additions: 12, deletions: 3 },
	progress: "task",
	duration: { roundMs: 12_300, sessionMs: 105_000 },
	runState: "Ready",
	quota: {
		provider: "codex",
		windows: [
			{ id: "primary", label: "5h", usedPercent: 7 },
			{ id: "secondary", label: "7d", usedPercent: 33 },
		],
		capturedAt: Date.now(),
		stale: false,
	},
	environment: { contextFiles: 2, skills: 67, tools: 7 },
	toolActivity: {
		Read: { active: 0, success: 6, error: 0 },
		Bash: { active: 0, success: 3, error: 0 },
	},
};

describe("current live-compatible output characterization", () => {
	it("keeps current stacked semantic output at 80/120/160 columns", () => {
		const config: StatuslineConfig = {
			...DEFAULT_CONFIG,
			widgets: [
				"mode", "model", "fast", "contextBar", "cost", "cache", "tokens", "path",
				"session", "branch", "branchDiff", "progress", "state", "duration", "toolActivity",
			],
			layout: "stacked",
			iconMode: "emoji",
			contextMode: "used",
			contextBarWidth: 8,
			toolActivityMode: "compact",
			widgetGroups: { mode: "project", path: "environment", branch: "environment", branchDiff: "environment" },
		};
		const characterized = {
			...hudSnapshot,
			auxUsage: { input: 3_700, output: 900, unsplit: 0, tokens: 4_600, cost: 0.03 },
		};
		const expectedByWidth: Record<number, string[]> = {
			80: [
				"  EDIT · gpt-5 high · ",
				"  Context [░░░░░░░░] 4% · 🎯 23.5% · 🔼 12.5KⅠ 3.7K · 🔽 3.2KⅠ 900",
				"  /home/user/proj · demo · 🏠 · +12 -3",
				"  task · Ready · 🕒 12s / 1m45s · ✓ core_tools x9",
			],
			120: [
				"  EDIT · gpt-5 high · ",
				"  Context [░░░░░░░░] 4% · $0.42Ⅰ $0.03 · 🎯 23.5% · 🔼 12.5KⅠ 3.7K · 🔽 3.2KⅠ 900",
				"  /home/user/proj · demo · 🏠 · +12 -3",
				"  task · Ready · 🕒 12s / 1m45s · ✓ core_tools x9",
			],
			160: [
				"  EDIT · gpt-5 high · ",
				"  Context [░░░░░░░░] 4% · $0.42Ⅰ $0.03 · 🎯 23.5% · 🔼 12.5KⅠ 3.7K · 🔽 3.2KⅠ 900",
				"  /home/user/proj · demo · 🏠 · +12 -3",
				"  task · Ready · 🕒 12s / 1m45s · ✓ core_tools x9",
			],
		};
		for (const width of [80, 120, 160]) {
			const rendered = renderStatusLine(
				buildWidgetSegments(characterized, config),
				config,
				TEST_THEME,
				width,
				(text, max) => text.slice(0, max),
				plainVisibleWidth,
			);
			assert.deepEqual(rendered, expectedByWidth[width]);
		}
	});
});

describe("renderStatusLine widget spacing", () => {
	it("renders dot and bar separators with equal side spacing", () => {
		assert.equal(render(2), "  left  ·  right");
		assert.equal(render(1, "bar"), "  left │ right");
	});

	it("keeps the separator when spacing is zero", () => {
		assert.equal(render(0), "  left·right");
	});

	it("keeps related token values dot-separated inside a bar-separated HUD", () => {
		const config = {
			...DEFAULT_CONFIG,
			separator: "bar" as const,
			iconMode: "plain" as const,
			widgets: ["tokens", "state"] as const,
		};
		const built = buildWidgetSegments(hudSnapshot, { ...config, widgets: [...config.widgets] });
		const line = renderStatusLine(
			built,
			{ ...config, widgets: [...config.widgets] },
			TEST_THEME,
			200,
			(text) => text,
		);
		assert.equal(line, "  in 12.5K · out 3.2K │ Ready");
	});
});

describe("groupSegmentsBySemantics", () => {
	it("uses canonical groups while preserving order within each group", () => {
		const segs: WidgetSegment[] = [
			{ id: "path", accent: "path", text: "p" },
			{ id: "tokens", accent: "usage", text: "t" },
			{ id: "model", accent: "model", text: "m" },
			{ id: "state", accent: "state", text: "s" },
			{ id: "context", accent: "usage", text: "c" },
		];
		const groups = groupSegmentsBySemantics(segs);
		assert.deepEqual(
			groups.map((group) => group.map((segment) => segment.id)),
			[["path", "model"], ["tokens", "context"], ["state"]],
		);
	});

	it("honors widgetGroups overrides for stacked partition", () => {
		const segs: WidgetSegment[] = [
			{ id: "path", accent: "path", text: "p" },
			{ id: "tokens", accent: "usage", text: "t" },
			{ id: "state", accent: "state", text: "s" },
		];
		const groups = groupSegmentsBySemantics(segs, {
			widgetGroups: { tokens: "activity", path: "environment" },
		});
		assert.deepEqual(
			groups.map((group) => group.map((segment) => segment.id)),
			[["path"], ["tokens", "state"]],
		);
	});
});

describe("responsive fitting", () => {
	it("keeps input and output tokens together", () => {
		const config = {
			...DEFAULT_CONFIG,
			iconMode: "plain" as const,
			widgets: ["tokens", "state"] as const,
		};
		const segs = buildWidgetSegments(hudSnapshot, { ...config, widgets: [...config.widgets] });
		const line = renderStatusLine(
			segs,
			{ ...config, widgets: [...config.widgets] },
			TEST_THEME,
			20,
			(text, max) => text.slice(0, max),
			plainVisibleWidth,
		);
		const plain = (Array.isArray(line) ? line[0]! : line).replace(ANSI_PATTERN, "");
		assert.equal(plain.includes("in 12.5K"), plain.includes("out 3.2K"));
	});

	it("drops account quota before current context", () => {
		const config = {
			...DEFAULT_CONFIG,
			widgets: ["contextBar", "quota"] as const,
			contextBarWidth: 4,
		};
		const segs = buildWidgetSegments(hudSnapshot, { ...config, widgets: [...config.widgets] });
		const fitted = fitSegmentsToWidth(
			segs,
			{ ...config, widgets: [...config.widgets] },
			TEST_THEME,
			27,
			plainVisibleWidth,
		);
		assert.deepEqual(fitted.map((segment) => segment.id), ["contextBar"]);
	});

	it("keeps live tool activity ahead of the generic working state", () => {
		const snapshot = {
			...hudSnapshot,
			runState: "Working" as const,
			toolActivity: {
				bash: { active: 1, success: 110, error: 13 },
				read: { active: 0, success: 80, error: 2 },
			},
		};
		const config = { ...DEFAULT_CONFIG, widgets: ["toolActivity", "state"] as const };
		const built = buildWidgetSegments(snapshot, { ...config, widgets: [...config.widgets] });
		const fitted = fitSegmentsToWidth(
			built,
			{ ...config, widgets: [...config.widgets] },
			TEST_THEME,
			30,
			plainVisibleWidth,
		);
		assert.deepEqual(fitted.map((segment) => segment.id), ["toolActivity"]);
	});
});

describe("terminal safety", () => {
	it("strips control sequences from every rendered segment", () => {
		const unsafe: WidgetSegment[] = [{
			id: "session",
			accent: "session",
			text: "\x1b]8;;https://example.com\x07name\x1b]8;;\x07\x1b[31m!\x1b[0m\nnext",
		}];
		const line = renderStatusLine(unsafe, DEFAULT_CONFIG, TEST_THEME, 200, (text) => text);
		const text = Array.isArray(line) ? line[0]! : line;
		assert.equal(text.includes("\x1b"), false);
		assert.equal(text.includes("\n"), false);
		assert.equal(text.includes("https://example.com"), false);
		assert.match(text, /name! next/);
	});
});

describe("host theme", () => {
	it("uses neutral hierarchy and the native thinking-level color", () => {
		const calls: Array<[string, string]> = [];
		const theme = {
			fg(color: string, text: string) {
				calls.push([color, text]);
				return text;
			},
		};
		const config = { ...DEFAULT_CONFIG, widgets: ["model", "path", "state"] as const };
		const built = buildWidgetSegments(hudSnapshot, { ...config, widgets: [...config.widgets] });
		const line = renderStatusLine(
			built,
			{ ...config, widgets: [...config.widgets] },
			theme,
			200,
			(text) => text,
		);
		assert.equal(Array.isArray(line), false);
		assert.ok(calls.some(([color, text]) => color === "text" && text === "gpt-5"));
		assert.ok(calls.some(([color, text]) => color === "thinkingHigh" && text === " high"));
		assert.ok(calls.some(([color, text]) => color === "muted" && text === "/home/user/proj"));
		assert.ok(calls.some(([color, text]) => color === "dim" && text === "Ready"));
	});
});

describe("renderStatusLine stacked", () => {
	it("returns canonical semantic lines while preserving within-group order", () => {
		const config: StatuslineConfig = {
			...DEFAULT_CONFIG,
			layout: "stacked" as const,
			widgets: [
				"path",
				"session",
				"model",
				"branch",
				"tokens",
				"cache",
				"environment",
				"toolActivity",
				"state",
			],
		};
		const segs = buildWidgetSegments(hudSnapshot, config);
		const lines = renderStatusLine(segs, config, TEST_THEME, 200, (text) => text);
		assert.ok(Array.isArray(lines));
		assert.equal((lines as string[]).length, 4);
		const plain = (lines as string[]).map((line) => line.replace(ANSI_PATTERN, ""));
		// session/mode now share the environment line; project keeps model/path/branch
		assert.match(plain[0]!, /gpt-5/);
		assert.doesNotMatch(plain[0]!, /demo/);
		assert.match(plain[1]!, /12\.5K/);
		assert.match(plain[2]!, /demo/);
		assert.match(plain[2]!, /context files/);
		assert.match(plain[3]!, /Ready/);
	});

	it("keeps each line within target widths", () => {
		const config: StatuslineConfig = {
			...DEFAULT_CONFIG,
			layout: "stacked" as const,
			widgets: [
				"path",
				"session",
				"model",
				"branch",
				"branchDiff",
				"mode",
				"fast",
				"contextBar",
				"tokens",
				"cache",
				"cost",
				"quota",
				"environment",
				"toolActivity",
				"progress",
				"duration",
				"state",
			],
		};
		const segs = buildWidgetSegments(hudSnapshot, config);
		for (const width of [40, 60, 80, 120]) {
			const lines = renderStatusLine(
				segs,
				config,
				TEST_THEME,
				width,
				(text, max) => text.slice(0, max),
				plainVisibleWidth,
			);
			const list = Array.isArray(lines) ? lines : [lines];
			for (const line of list) {
				assert.ok(plainVisibleWidth(line) <= width, `width ${width}: ${plainVisibleWidth(line)} > ${width}`);
			}
		}
	});
});
