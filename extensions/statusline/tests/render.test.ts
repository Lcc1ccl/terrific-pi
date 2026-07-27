import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG, resolveEffectiveRenderConfig } from "../lib/config.ts";
import {
	fitSegmentsToWidth,
	groupSegmentsBySemantics,
	plainVisibleWidth,
	renderStatusLine,
	withTerrificStateSpinner,
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

describe("renderStatusLine terrific", () => {
	const widgets = [
		"path", "session", "model", "mode", "fast", "tokens", "cache", "cost", "context",
		"contextBar", "branch", "branchDiff", "progress", "duration", "state", "quota",
		"environment", "toolActivity",
	] as const;
	const config: StatuslineConfig = { ...DEFAULT_CONFIG, layout: "terrific", widgets: [...widgets] };

	it("renders all state/width/height combinations within the two-line contract", () => {
		for (const state of ["Ready", "Thinking", "Working", "Waiting"] as const) {
			const built = buildWidgetSegments({ ...hudSnapshot, runState: state }, config);
			for (const width of [40, 80, 120, 160]) {
				for (const rows of [16, 20, 24]) {
					const rendered = renderStatusLine(built, config, TEST_THEME, width, truncateToWidth, visibleWidth, rows);
					const lines = Array.isArray(rendered) ? rendered : [rendered];
					assert.ok(lines.length <= 2, `${state}/${width}/${rows}: ${lines.length} lines`);
					assert.equal(lines.length, width < 80 || rows < 20 ? 1 : 2, `${state}/${width}/${rows}`);
					for (const line of lines) assert.ok(visibleWidth(line) <= width, `${state}/${width}/${rows}: ${visibleWidth(line)}`);
					if (lines.length === 1) {
						assert.match(lines[0]!, new RegExp(state));
						assert.match(lines[0]!, /gpt-5/);
						if (width >= 80) assert.match(lines[0]!, /Context/);
					}
				}
			}
		}
	});

	it("retains every frozen zone item at 120x24", () => {
		const active = { ...hudSnapshot, runState: "Working" as const };
		const effective = resolveEffectiveRenderConfig(config, true);
		const segments = withTerrificStateSpinner(buildWidgetSegments(active, effective), active.runState, 0, false);
		const lines = renderStatusLine(segments, effective, TEST_THEME, 120, truncateToWidth, visibleWidth, 24) as string[];
		assert.equal(lines.length, 2);
		assert.match(lines[0]!, /\/home\/user\/proj.*(?:main|🏠).*gpt-5.*high.*EDIT.*/);
		assert.match(lines[1]!, /⠋ Working.*12s.*task.*12\.5K.*ctx.*\$0\.42.*5h/);
		assert.equal((lines[1]!.match(/ctx/g) ?? []).length, 1);
		for (const line of lines) assert.ok(visibleWidth(line) <= 120);
	});

	it("uses only the approved zones and one context representation", () => {
		const rendered = renderStatusLine(buildWidgetSegments(hudSnapshot, config), config, TEST_THEME, 160, truncateToWidth, visibleWidth, 24);
		assert.ok(Array.isArray(rendered));
		const [line1, line2] = rendered as string[];
		assert.match(line1!, /\/home\/user\/proj.*(?:main|🏠).*gpt-5.*EDIT.*/);
		assert.doesNotMatch(line1!, /demo|\+12 -3|Ready|12\.5K|Context/);
		assert.match(line2!, /Ready.*12s.*task.*12\.5K.*Context.*\$0\.42.*5h/);
		assert.doesNotMatch(line2!, /gpt-5|demo|🎯|cache \d|context files|skills|tools|Read x|Bash x/);
		assert.equal((line2!.match(/Context/g) ?? []).length, 1);
		assert.equal(visibleWidth(line1!), 160);
		assert.equal(visibleWidth(line2!), 160);
	});

	it("falls back to contextBar only when context is absent", () => {
		const onlyBar = { ...config, widgets: config.widgets.filter((id) => id !== "context") };
		const lines = renderStatusLine(buildWidgetSegments(hudSnapshot, onlyBar), onlyBar, TEST_THEME, 160, truncateToWidth, visibleWidth, 24) as string[];
		assert.match(lines[1]!, /Context \[/);
		assert.equal((lines[1]!.match(/Context/g) ?? []).length, 1);
	});

	it("decorates only actual non-Ready state with changing active spinner frames", () => {
		const state: WidgetSegment[] = [{ id: "state", accent: "state", text: "Thinking", parts: [{ text: "Thinking", tone: "thinkingHigh" }], priority: 5 }];
		const first = withTerrificStateSpinner(state, "Thinking", 0, false)[0]!;
		const second = withTerrificStateSpinner(state, "Thinking", 1, false)[0]!;
		assert.notEqual(first.text, second.text);
		assert.equal(first.parts?.[0]?.tone, "active");
		assert.equal(withTerrificStateSpinner(state, "Thinking", 0, true)[0]!.text, "* Thinking");
		assert.deepEqual(withTerrificStateSpinner(state, "Ready", 3, false), state);
		assert.equal(state[0]!.text, "Thinking");
		for (const width of [7, 40, 80]) {
			const rendered = renderStatusLine(withTerrificStateSpinner(state, "Thinking", 2, false), config, TEST_THEME, width, truncateToWidth, visibleWidth, 24);
			for (const line of Array.isArray(rendered) ? rendered : [rendered]) assert.ok(visibleWidth(line) <= width);
		}
	});

	it("is ANSI-safe with hostile CJK segments and tiny widths", () => {
		const hostile: WidgetSegment[] = [
			{ id: "state", accent: "state", text: "工作中", parts: [{ text: "\x1b[31m工作中\x1b[0m" }], priority: 5 },
			{ id: "model", accent: "model", text: "模型超长", priority: 8 },
			{ id: "context", accent: "usage", text: "上下文 99%", priority: 20 },
		];
		const ansiTheme = { fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m` };
		for (const width of [1, 7, 40, 80]) {
			const rendered = renderStatusLine(hostile, config, ansiTheme, width, truncateToWidth, visibleWidth, 24);
			for (const line of Array.isArray(rendered) ? rendered : [rendered]) {
				assert.ok(visibleWidth(line) <= width);
				assert.doesNotMatch(line, /\x1b\[[^m]*$/);
			}
		}
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
