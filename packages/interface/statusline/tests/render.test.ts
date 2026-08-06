import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import {
	fitSegmentsToWidth,
	groupSegmentsByLines,
	plainVisibleWidth,
	renderEditorStatus,
	renderStatusLine,
} from "../lib/render.ts";
import { buildWidgetSegments } from "../lib/widgets.ts";
import type { StatusSnapshot, StatuslineConfig, WidgetLines, WidgetSegment } from "../lib/types.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TEST_THEME = { fg: (_color: string, text: string) => text };

function lines(partial: Partial<WidgetLines>): WidgetLines {
	return { line0: [], line1: [], line2: [], line3: [], line4: [], ...partial };
}

function config(widgetLines: WidgetLines, partial: Partial<StatuslineConfig> = {}): StatuslineConfig {
	return { ...DEFAULT_CONFIG, lines: widgetLines, ...partial };
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

describe("editor status projection", () => {
	it("uses arbitrary LINE0 order, separator, tones, and width priorities", () => {
		const value = config(lines({
			line0: ["tokens", "path", "model", "mode", "fast"],
			line1: ["state"],
		}), { iconMode: "plain", separator: "bar", spacing: 1 });
		const built = buildWidgetSegments(hudSnapshot, value);
		assert.equal(
			renderEditorStatus(built, value, TEST_THEME, 80, (text) => text),
			"in 12.5K · out 3.2K │ /home/user/proj │ gpt-5 high │ EDIT │ fast",
		);
		assert.equal(
			renderEditorStatus(built, value, TEST_THEME, 12, truncateToWidth, visibleWidth),
			"gpt-5 high",
		);
	});
});

describe("explicit footer lines", () => {
	it("preserves configured line and within-line order", () => {
		const value = config(lines({
			line0: ["model", "mode", "fast"],
			line1: ["contextBar", "cost", "cache", "tokens"],
			line2: ["path", "session", "branch", "branchDiff"],
			line3: ["progress", "state", "duration", "toolActivity"],
		}), { iconMode: "emoji", contextMode: "used", contextBarWidth: 8 });
		const snapshot = {
			...hudSnapshot,
			auxUsage: { input: 3_700, output: 900, unsplit: 0, tokens: 4_600, cost: 0.03 },
		};
		assert.deepEqual(
			renderStatusLine(buildWidgetSegments(snapshot, value), value, TEST_THEME, 120, (text) => text),
			[
				"  Context [░░░░░░░░] 4% · $0.42Ⅰ $0.03 · 🎯 23.5% · 🔼 12.5KⅠ 3.7K · 🔽 3.2KⅠ 900",
				"  /home/user/proj · demo · 🏠 · +12 -3",
				"  task · Ready · 🕒 12s / 1m45s · ✓ core_tools x9",
			],
		);
	});

	it("can render LINE0 first for footer fallback", () => {
		const value = config(lines({ line0: ["model"], line2: ["state"] }));
		assert.deepEqual(
			renderStatusLine(buildWidgetSegments(hudSnapshot, value), value, TEST_THEME, 80, (text) => text, undefined, true),
			["  gpt-5 high", "  Ready"],
		);
	});

	it("keeps each nonempty line within target widths", () => {
		const value = config(lines({
			line0: ["model", "mode", "fast"],
			line1: ["path", "session", "branch", "branchDiff"],
			line2: ["contextBar", "tokens", "cache", "cost", "quota"],
			line3: ["environment", "toolActivity"],
			line4: ["progress", "duration", "state"],
		}));
		const segments = buildWidgetSegments(hudSnapshot, value);
		for (const width of [40, 60, 80, 120]) {
			for (const line of renderStatusLine(segments, value, TEST_THEME, width, truncateToWidth, visibleWidth, true)) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} > ${width}`);
			}
		}
	});
});

describe("widget spacing", () => {
	const segments: WidgetSegment[] = [
		{ id: "path", accent: "path", text: "left" },
		{ id: "state", accent: "state", text: "right" },
	];
	function render(spacing: number, separator: "dot" | "bar" = "dot"): string {
		const value = config(lines({ line1: ["path", "state"] }), { spacing, separator });
		return renderStatusLine(segments, value, TEST_THEME, 200, (text) => text)[0]!.replace(ANSI_PATTERN, "");
	}

	it("renders dot and bar separators with equal side spacing", () => {
		assert.equal(render(2), "  left  ·  right");
		assert.equal(render(1, "bar"), "  left │ right");
		assert.equal(render(0), "  left·right");
	});

	it("keeps related token values dot-separated inside a bar-separated line", () => {
		const value = config(lines({ line1: ["tokens", "state"] }), { separator: "bar", iconMode: "plain" });
		assert.deepEqual(
			renderStatusLine(buildWidgetSegments(hudSnapshot, value), value, TEST_THEME, 200, (text) => text),
			["  in 12.5K · out 3.2K │ Ready"],
		);
	});
});

describe("groupSegmentsByLines", () => {
	it("uses only explicit lines and preserves configured order", () => {
		const segments: WidgetSegment[] = [
			{ id: "path", accent: "path", text: "p" },
			{ id: "tokens", accent: "usage", text: "t" },
			{ id: "model", accent: "model", text: "m" },
			{ id: "state", accent: "state", text: "s" },
		];
		const value = config(lines({ line0: ["state", "tokens"], line3: ["model", "path"] }));
		assert.deepEqual(
			groupSegmentsByLines(segments, value).map((group) => group.map((segment) => segment.id)),
			[["state", "tokens"], [], [], ["model", "path"], []],
		);
	});
});

describe("responsive fitting", () => {
	it("keeps input and output tokens together", () => {
		const value = config(lines({ line1: ["tokens", "state"] }), { iconMode: "plain" });
		const rendered = renderStatusLine(
			buildWidgetSegments(hudSnapshot, value),
			value,
			TEST_THEME,
			20,
			(text, max) => text.slice(0, max),
			plainVisibleWidth,
		)[0]!;
		assert.equal(rendered.includes("in 12.5K"), rendered.includes("out 3.2K"));
	});

	it("drops account quota before current context", () => {
		const value = config(lines({ line1: ["contextBar", "quota"] }), { contextBarWidth: 4 });
		const fitted = fitSegmentsToWidth(
			buildWidgetSegments(hudSnapshot, value), value, TEST_THEME, 27, plainVisibleWidth,
		);
		assert.deepEqual(fitted.map((segment) => segment.id), ["contextBar"]);
	});

	it("keeps live tool activity ahead of generic working state", () => {
		const snapshot = {
			...hudSnapshot,
			runState: "Working" as const,
			toolActivity: {
				bash: { active: 1, success: 110, error: 13 },
				read: { active: 0, success: 80, error: 2 },
			},
		};
		const value = config(lines({ line1: ["toolActivity", "state"] }));
		const fitted = fitSegmentsToWidth(
			buildWidgetSegments(snapshot, value), value, TEST_THEME, 30, plainVisibleWidth,
		);
		assert.deepEqual(fitted.map((segment) => segment.id), ["toolActivity"]);
	});
});

describe("terminal safety and host theme", () => {
	it("strips control sequences from every rendered segment", () => {
		const unsafe: WidgetSegment[] = [{
			id: "session",
			accent: "session",
			text: "\x1b]8;;https://example.com\x07name\x1b]8;;\x07\x1b[31m!\x1b[0m\nnext",
		}];
		const value = config(lines({ line1: ["session"] }));
		const text = renderStatusLine(unsafe, value, TEST_THEME, 200, (line) => line)[0]!;
		assert.equal(text.includes("\x1b"), false);
		assert.equal(text.includes("\n"), false);
		assert.equal(text.includes("https://example.com"), false);
		assert.match(text, /name! next/);
	});

	it("uses neutral hierarchy and native thinking colors", () => {
		const calls: Array<[string, string]> = [];
		const theme = { fg(color: string, text: string) { calls.push([color, text]); return text; } };
		const value = config(lines({ line1: ["model", "path", "state"] }));
		renderStatusLine(buildWidgetSegments(hudSnapshot, value), value, theme, 200, (text) => text);
		assert.ok(calls.some(([color, text]) => color === "text" && text === "gpt-5"));
		assert.ok(calls.some(([color, text]) => color === "thinkingHigh" && text === " high"));
		assert.ok(calls.some(([color, text]) => color === "muted" && text === "/home/user/proj"));
		assert.ok(calls.some(([color, text]) => color === "dim" && text === "Ready"));
	});
});
