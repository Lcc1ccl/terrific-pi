import { performance } from "node:perf_hooks";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG, resolveEffectiveRenderConfig } from "../lib/config.ts";
import { renderStatusLine, withTerrificStateSpinner } from "../lib/render.ts";
import type { StatusSnapshot, StatuslineConfig } from "../lib/types.ts";
import { buildWidgetSegments } from "../lib/widgets.ts";

const SAMPLES = 30;
const ITERATIONS_PER_SAMPLE = 100;
const configured: StatuslineConfig = {
	...DEFAULT_CONFIG,
	layout: "terrific",
	widgets: [
		"path", "session", "model", "mode", "fast", "tokens", "cache", "cost", "context",
		"contextBar", "branch", "branchDiff", "progress", "duration", "state", "quota",
		"environment", "toolActivity",
	],
};
const snapshot: StatusSnapshot = {
	cwd: "/home/user/vendor/terrific-pi",
	sessionName: "benchmark",
	modelId: "gpt-5",
	thinkingLevel: "high",
	hasReasoning: true,
	mode: "EDIT",
	fast: "fast",
	tokens: { input: 12_500, output: 3_200, cacheRead: 4_000, cacheWrite: 500 },
	cost: 0.42,
	context: { tokens: 40_000, contextWindow: 100_000, percent: 40 },
	branch: "feature/footer",
	branchDiff: { additions: 120, deletions: 30 },
	progress: "task 2/3",
	duration: { roundMs: 12_300, sessionMs: 105_000 },
	runState: "Working",
	environment: { contextFiles: 2, skills: 67, tools: 7 },
	toolActivity: { Bash: { active: 1, success: 8, error: 0 }, Read: { active: 0, success: 12, error: 0 } },
};
const theme = { fg: (_color: string, text: string) => text };
let sink = 0;

function renderHotPath(width: number, tick: number): void {
	const effectiveConfig = resolveEffectiveRenderConfig(configured, true);
	const builtSegments = buildWidgetSegments(snapshot, effectiveConfig);
	const segments = withTerrificStateSpinner(builtSegments, snapshot.runState, tick, false);
	const rendered = renderStatusLine(
		segments,
		effectiveConfig,
		theme,
		width,
		truncateToWidth,
		visibleWidth,
		24,
	);
	sink += Array.isArray(rendered) ? rendered.length : rendered.length > 0 ? 1 : 0;
}

console.log("scope=effective Terrific pure render hot path (resolve config + build widgets + spinner + render); excludes host snapshot API reads");
for (const width of [80, 120, 160]) {
	for (let index = 0; index < 10 * ITERATIONS_PER_SAMPLE; index += 1) renderHotPath(width, index);
	const samples: number[] = [];
	for (let sample = 0; sample < SAMPLES; sample += 1) {
		const start = performance.now();
		for (let iteration = 0; iteration < ITERATIONS_PER_SAMPLE; iteration += 1) {
			renderHotPath(width, sample * ITERATIONS_PER_SAMPLE + iteration);
		}
		samples.push((performance.now() - start) / ITERATIONS_PER_SAMPLE);
	}
	samples.sort((left, right) => left - right);
	const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
	console.log(`width=${width} samples=${SAMPLES} iterations/sample=${ITERATIONS_PER_SAMPLE} p95=${p95.toFixed(3)}ms/render`);
	if (p95 >= 16) throw new Error(`Terrific hot-path width=${width} p95 ${p95.toFixed(3)}ms must be <16ms`);
}
void sink;
