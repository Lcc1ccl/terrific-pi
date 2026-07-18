import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import {
	DARK_PALETTE,
	groupSegmentsBySemantics,
	plainVisibleWidth,
	renderStatusLine,
} from "../lib/render.ts";
import { buildWidgetSegments } from "../lib/widgets.ts";
import type { StatusSnapshot, WidgetSegment } from "../lib/types.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const segments = [
	{ id: "path" as const, accent: "path" as const, text: "left" },
	{ id: "state" as const, accent: "state" as const, text: "right" },
];

function render(spacing: number, legacySeparator = ""): string {
	const config = {
		...DEFAULT_CONFIG,
		spacing,
		separator: legacySeparator,
	};
	const line = renderStatusLine(segments, config, DARK_PALETTE, 200, (text) => text);
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

describe("renderStatusLine widget spacing", () => {
	it("keeps the fixed separator and adds equal spaces on both sides", () => {
		assert.equal(render(2, "|"), "  left  ·  right");
	});

	it("keeps the separator when spacing is zero", () => {
		assert.equal(render(0), "  left·right");
	});
});

describe("groupSegmentsBySemantics", () => {
	it("breaks only when adjacent groups change", () => {
		const segs: WidgetSegment[] = [
			{ id: "path", accent: "path", text: "p" },
			{ id: "model", accent: "model", text: "m" },
			{ id: "tokens", accent: "usage", text: "t" },
			{ id: "state", accent: "state", text: "s" },
		];
		const groups = groupSegmentsBySemantics(segs);
		assert.deepEqual(
			groups.map((group) => group.map((segment) => segment.id)),
			[["path", "model"], ["tokens"], ["state"]],
		);
	});
});

describe("renderStatusLine stacked", () => {
	it("returns multiple lines for stacked layout without reordering", () => {
		const config = {
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
		const lines = renderStatusLine(segs, config, DARK_PALETTE, 200, (text) => text);
		assert.ok(Array.isArray(lines));
		assert.equal((lines as string[]).length, 4);
		const plain = (lines as string[]).map((line) => line.replace(ANSI_PATTERN, ""));
		assert.match(plain[0]!, /demo/);
		assert.match(plain[0]!, /gpt-5/);
		assert.match(plain[1]!, /12\.5K/);
		assert.match(plain[2]!, /context files/);
		assert.match(plain[3]!, /Ready/);
	});

	it("keeps each line within target widths", () => {
		const config = {
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
				DARK_PALETTE,
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
