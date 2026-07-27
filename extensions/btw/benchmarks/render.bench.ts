import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { visibleWidth } from "@earendil-works/pi-tui";

import { TextOverlay } from "../lib/overlay.ts";
import { selectMenu } from "../lib/select-menu.ts";

const WIDTH = 160;
const SAMPLE_COUNT = 30;
const ITERATIONS_PER_SAMPLE = 100;
const WARMUP_BATCHES = 3;
const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };

let menu: { render(width: number): string[] } | undefined;
await selectMenu({
	mode: "tui",
	ui: {
		select: async () => undefined,
		custom: async (factory: any) => {
			menu = factory(
				{ terminal: { rows: 50 }, requestRender() {} }, theme,
				{ matches: () => false, getKeys: () => [] }, () => {},
			);
			return undefined;
		},
	},
} as never, "BTW benchmark\nactive pure renderer", Array.from({ length: 12 }, (_, index) => `route-${index} — ${"界面🙂 detail ".repeat(8)}`), {}, { active: true, ascii: false });

const overlay = new TextOverlay(
	theme as never,
	{ title: "BTW · provider/model", lines: Array.from({ length: 80 }, (_, index) => `第${index}行 🙂 ${"answer ".repeat(18)}`) },
	() => {},
	() => {},
	{ active: true, ascii: false, getTerminalRows: () => 50 },
);

function benchmark(name: string, render: () => string[]): void {
	for (let batch = 0; batch < WARMUP_BATCHES; batch += 1) {
		for (let iteration = 0; iteration < ITERATIONS_PER_SAMPLE; iteration += 1) render();
	}
	const samples: number[] = [];
	let lines: string[] = [];
	for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
		const started = performance.now();
		for (let iteration = 0; iteration < ITERATIONS_PER_SAMPLE; iteration += 1) lines = render();
		samples.push((performance.now() - started) / ITERATIONS_PER_SAMPLE);
	}
	const sorted = [...samples].sort((left, right) => left - right);
	const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
	assert.equal(samples.length, SAMPLE_COUNT);
	assert.ok(ITERATIONS_PER_SAMPLE >= 100);
	assert.ok(lines.every((line) => visibleWidth(line) <= WIDTH));
	assert.ok(p95 < 16, `${name} per-render p95 ${p95.toFixed(3)}ms`);
	console.log(`btw ${name} width=${WIDTH} samples=${SAMPLE_COUNT} iterations/sample=${ITERATIONS_PER_SAMPLE} nearest-rank-per-render-p95=${p95.toFixed(3)}ms`);
}

assert.ok(menu);
benchmark("menu", () => menu!.render(WIDTH));
benchmark("overlay", () => overlay.render(WIDTH));
