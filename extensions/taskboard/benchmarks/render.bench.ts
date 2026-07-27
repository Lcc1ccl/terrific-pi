import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { formatTaskboardLines, type ProcessTheme } from "../lib/render.ts";
import type { TaskboardRenderState } from "../lib/types.ts";

const WIDTH = 160;
const SAMPLES = 30;
const ITERATIONS_PER_SAMPLE = 100;
const NOW = 1_726_000_065_000;
const usage = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0) =>
	({ input, output, cacheRead, cacheWrite, cost });
const theme: ProcessTheme = { fg: (_color, text) => text, bold: (text) => text };
const state: TaskboardRenderState = {
	viewMode: "full",
	activityMode: "full",
	expanded: true,
	now: NOW,
	snapshot: {
		version: 1,
		title: "Ship the Terrific Taskboard renderer with responsive evidence",
		status: "running",
		steps: [
			{ text: "Capture inactive renderer golden", status: "done" },
			{ text: "Implement the active compact and expanded renderer", status: "active" },
			{ text: "Validate CJK and ANSI width handling", status: "pending" },
			{ text: "Run package checks and benchmark", status: "pending" },
			{ text: "Report acceptance evidence", status: "pending" },
		],
		update: "Renderer implementation is active",
		artifacts: [{ kind: "test", label: "taskboard-check" }],
		startedAt: NOW - 120_000,
		updatedAt: NOW,
	},
	telemetry: {
		turns: 4,
		usage: usage(52_000, 3_200, 39_000, 800, 0.51),
		models: ["openai/gpt-5.6-sol"],
		steps: [
			{ text: "Capture inactive renderer golden", activeMs: 12_000, turns: 1, usage: usage(8_000, 400, 6_000), models: ["openai/gpt-5.6-sol"] },
			{ text: "Implement the active compact and expanded renderer", activeMs: 45_000, activeSince: NOW - 20_000, turns: 3, usage: usage(44_000, 2_800, 33_000, 800, 0.51), models: ["openai/gpt-5.6-sol"] },
			{ text: "Validate CJK and ANSI width handling", activeMs: 0, turns: 0, usage: usage(), models: [] },
			{ text: "Run package checks and benchmark", activeMs: 0, turns: 0, usage: usage(), models: [] },
			{ text: "Report acceptance evidence", activeMs: 0, turns: 0, usage: usage(), models: [] },
		],
	},
	activity: {
		stage: "running_tools",
		activeTools: [{ callId: "benchmark", toolName: "edit", label: "lib/render.ts", startedAt: NOW - 2_000 }],
	},
};
let sink = 0;

function render(): void {
	sink += formatTaskboardLines(state, WIDTH, theme, {
		variant: "terrific",
		terminalRows: 24,
	}).length;
}

for (let index = 0; index < 10 * ITERATIONS_PER_SAMPLE; index += 1) render();
const samples: number[] = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
	const started = performance.now();
	for (let iteration = 0; iteration < ITERATIONS_PER_SAMPLE; iteration += 1) render();
	samples.push((performance.now() - started) / ITERATIONS_PER_SAMPLE);
}

assert.equal(samples.length, 30);
samples.sort((left, right) => left - right);
const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
assert.ok(p95 < 16, `Taskboard render p95 ${p95.toFixed(3)}ms must be <16ms`);
process.stdout.write(`taskboard benchmark: width=${WIDTH} samples=${SAMPLES} iterations/sample=${ITERATIONS_PER_SAMPLE} p95=${p95.toFixed(3)}ms/render\n`);
void sink;
