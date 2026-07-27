import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { visibleWidth } from "@earendil-works/pi-tui";

import { selectMenu } from "../lib/select-menu.ts";

const WIDTH = 160;
const SAMPLE_COUNT = 30;
const ITERATIONS_PER_SAMPLE = 100;
const WARMUP_BATCHES = 3;
let component: { render(width: number): string[] } | undefined;

await selectMenu({
	mode: "tui",
	ui: {
		select: async () => undefined,
		custom: async (factory: any) => {
			component = factory(
				{ terminal: { rows: 50 }, requestRender() {} },
				{ fg: (_token: string, text: string) => text, bold: (text: string) => text },
				{ matches: () => false, getKeys: (binding: string) => ({
					"tui.select.up": ["up"], "tui.select.down": ["down"],
					"tui.select.confirm": ["enter"], "tui.select.cancel": ["escape"],
				}[binding] ?? []) },
				() => {},
			);
			return undefined;
		},
	},
} as never, "Mode benchmark\nactive pure renderer", Array.from({ length: 12 }, (_, index) => `mode-${index} — ${"界面🙂 detail ".repeat(8)}`), {}, { active: true, ascii: false });

assert.ok(component);
const render = () => component!.render(WIDTH);
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
assert.ok(p95 < 16, `mode menu per-render p95 ${p95.toFixed(3)}ms`);
console.log(`mode menu width=${WIDTH} samples=${SAMPLE_COUNT} iterations/sample=${ITERATIONS_PER_SAMPLE} nearest-rank-per-render-p95=${p95.toFixed(3)}ms`);
