import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { formatRunNotification, formatRuntime, formatWorktree } from "../lib/format.ts";
import { resolveGlyphs, resolveIconMode } from "../lib/glyphs.ts";
import { renderStatusLine } from "../lib/render.ts";
import type { StatusSnapshot, StatuslineConfig, WidgetId, WidgetLines } from "../lib/types.ts";
import { buildWidgetSegments } from "../lib/widgets.ts";

const snapshot: StatusSnapshot = {
	cwd: "/home/用户/一个很长的项目路径/with-osc-\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
	sessionName: "迁移验证会话",
	modelId: "provider/一个非常长的模型名称-with-ansi-\x1b[31mred\x1b[0m",
	thinkingLevel: "high",
	hasReasoning: true,
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	cost: 0,
	worktree: {
		branch: "feature/迁移-very-long-branch",
		oid: "abcdef1234567890",
		detached: false,
		ahead: 2,
		behind: 3,
		stash: 4,
		conflicted: 1,
		renamed: 1,
		deleted: 2,
		staged: 5,
		modified: 6,
		untracked: 7,
	},
	runtime: { name: "nodejs", version: "22.10.0" },
	performance: {
		tps: 42.5,
		ttftMs: 1_200,
		totalMs: 5_000,
		inputTokens: 50,
		outputTokens: 20,
		stallMs: 4_300,
		stallCount: 1,
		rateUsdPerMTokens: 4,
		generationMs: 470,
		totalTokens: 70,
		costUsd: 0.00028,
		measurementMs: 470,
		usageAvailable: true,
	},
	runState: "Ready",
};

const runMetricWidgets = [
	"runTps", "runTtft", "runDuration", "runTokens", "runStalls", "runCostRate",
] as const;

function lines(partial: Partial<WidgetLines>): WidgetLines {
	return { line0: [], line1: [], line2: [], line3: [], line4: [], ...partial };
}

function configFor(widgets: readonly WidgetId[], partial: Partial<StatuslineConfig> = {}): StatuslineConfig {
	return { ...DEFAULT_CONFIG, lines: lines({ line1: [...widgets] }), ...partial };
}

describe("glyph modes", () => {
	it("resolves nerd ascii and auto while retaining emoji/plain", () => {
		assert.equal(resolveIconMode("emoji"), "emoji");
		assert.equal(resolveIconMode("plain"), "plain");
		assert.equal(resolveIconMode("nerd"), "nerd");
		assert.equal(resolveIconMode("ascii"), "ascii");
		assert.equal(resolveIconMode("auto", { TERM_PROGRAM: "WezTerm" }), "nerd");
		assert.equal(resolveIconMode("auto", { TERM: "xterm-256color" }), "ascii");
		for (const mode of ["emoji", "nerd", "ascii"] as const) {
			assert.notEqual(resolveGlyphs(mode).branch, "");
			assert.notEqual(resolveGlyphs(mode).worktree, "");
			assert.notEqual(resolveGlyphs(mode).context, "");
		}
		for (const mode of ["emoji", "plain", "nerd", "ascii", "auto"] as const) {
			assert.notEqual(resolveGlyphs(mode).speed, "");
		}
		assert.equal(resolveGlyphs("emoji").folder, "📁");
		assert.equal(resolveGlyphs("emoji").branch, "⑂");
		assert.equal(resolveGlyphs("emoji").worktree, "🌳");
		assert.equal(resolveGlyphs("emoji").context, "🪟");
	});
});

describe("run metric widgets", () => {
	it("formats each settled-run metric independently", () => {
		const segments = buildWidgetSegments(snapshot, configFor(runMetricWidgets, { iconMode: "plain" }));
		assert.deepEqual(segments.map((segment) => segment.id), runMetricWidgets);
		assert.deepEqual(segments.map((segment) => segment.text), [
			"TPS 42.5", "TTFT 1.2s", "run 5.0s", "in 50 · out 20", "stall 1/4.3s", "$4.00/M",
		]);
	});

	it("keeps timing visible when usage is unavailable", () => {
		const segments = buildWidgetSegments({
			...snapshot,
			performance: {
				...snapshot.performance!,
				tps: null,
				inputTokens: null,
				outputTokens: null,
				rateUsdPerMTokens: null,
				usageAvailable: false,
			},
		}, configFor(["runTps", "runTtft", "runTokens", "runCostRate"], { iconMode: "plain" }));
		assert.deepEqual(segments.map((segment) => segment.text), ["TPS ?", "TTFT 1.2s", "usage ?"]);
	});

	it("formats notification text without separators for omitted metrics", () => {
		assert.equal(formatRunNotification({
			...snapshot.performance!,
			tps: null,
			inputTokens: null,
			outputTokens: null,
			stallMs: 0,
			stallCount: 0,
			rateUsdPerMTokens: null,
			usageAvailable: false,
		}, "plain").text, "TPS ? · TTFT 1.2s · run 5.0s · usage ?");
	});
});

describe("ordinary widget integration", () => {
	it("builds widgets in flattened LINE0-LINE4 order", () => {
		const config: StatuslineConfig = {
			...DEFAULT_CONFIG,
			lines: lines({ line0: ["runTps"], line2: ["runtime", "runTtft"], line4: ["worktree"] }),
			iconMode: "ascii",
		};
		const segments = buildWidgetSegments(snapshot, config);
		assert.deepEqual(segments.map((segment) => segment.id), ["runTps", "runtime", "runTtft", "worktree"]);
		assert.deepEqual(segments.map((segment) => segment.accent), ["usage", "neutral", "usage", "branch"]);
		assert.match(formatWorktree(snapshot.worktree!, "ascii").text, /feature\/迁移.*\^v2\/3.*S4.*=1.*x2.*!6.*r1.*A5.*\?7/);
		assert.equal(formatRuntime(snapshot.runtime!, "ascii").text, "node 22.10.0");
		assert.equal(formatRuntime({ name: "runtime", ambiguous: true }, "plain").text, "runtime ?");
	});

	it("renders up to five explicit lines safely at 40/80/120/160 columns", () => {
		const config: StatuslineConfig = {
			...DEFAULT_CONFIG,
			lines: lines({
				line0: ["model", "runTps"],
				line1: ["path", "worktree"],
				line2: ["runtime", "runTtft", "runDuration"],
				line3: ["runTokens", "runStalls", "runCostRate"],
				line4: ["state"],
			}),
			iconMode: "nerd",
		};
		const segments = buildWidgetSegments(snapshot, config);
		for (const width of [40, 80, 120, 160]) {
			const rendered = renderStatusLine(
				segments,
				config,
				{ fg: (_color, text) => text },
				width,
				truncateToWidth,
				visibleWidth,
				"line0",
			);
			for (const line of rendered) {
				assert.equal(line.includes("https://example.com"), false);
				assert.equal(line.includes("\n"), false);
				assert.ok(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)} ${line}`);
			}
		}
	});

	it("keeps formatter/build p95 bounded", () => {
		const config = configFor(["worktree", "runtime", ...runMetricWidgets]);
		const samples: number[] = [];
		for (let sample = 0; sample < 20; sample++) {
			const started = performance.now();
			for (let index = 0; index < 500; index++) buildWidgetSegments(snapshot, config);
			samples.push(performance.now() - started);
		}
		samples.sort((left, right) => left - right);
		assert.ok(samples[Math.ceil(samples.length * 0.95) - 1]! < 100);
	});
});
