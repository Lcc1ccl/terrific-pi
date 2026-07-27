import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { createToolRenderController } from "../lib/compat/tool-render.ts";
import { renderUserMessageBox } from "../lib/compat/user-message.ts";

const WIDTH = 160;
const WARMUP = 20;
const SAMPLES = 30;
const theme = {
	fg(_color: string, text: string) { return text; },
	getBgAnsi() { return ""; },
	bold(text: string) { return text; },
};
const originalUser = function (width: number): string[] {
	const content = "Representative **active** user content 中文🙂";
	return [" ".repeat(width), `${content}${" ".repeat(width - 46)}`, " ".repeat(width)];
};
const userRender = () => renderUserMessageBox({}, WIDTH, originalUser, theme, true, true);

const toolController = createToolRenderController({
	isEnabled: () => true,
	isTerrificNativeActive: () => true,
	getTheme: () => theme,
	now: () => 1_250,
});
const toolResult = { content: [{ type: "text", text: "one\ntwo" }], details: { exitCode: 0 }, isError: false };
toolController.start({ toolCallId: "benchmark-bash", toolName: "bash", args: {}, cwd: "/workspace", timestamp: 1_000 });
toolController.end({ toolCallId: "benchmark-bash", toolName: "bash", result: toolResult, isError: false, timestamp: 1_250 });
const toolInstance = {
	toolCallId: "benchmark-bash",
	toolName: "bash",
	args: {},
	cwd: "/workspace",
	executionStarted: true,
	isPartial: false,
	result: toolResult,
	expanded: false,
	ui: { requestRender() {} },
};
const toolRender = () => toolController.render(toolInstance, WIDTH, () => ["native"]);
const renders = [userRender, toolRender] as const;

for (let index = 0; index < WARMUP; index += 1) renders[index % renders.length]!();
const samples: number[] = [];
for (let index = 0; index < SAMPLES; index += 1) {
	const render = renders[index % renders.length]!;
	const started = performance.now();
	render();
	samples.push(performance.now() - started);
}
toolController.dispose();

assert.equal(samples.length, 30);
const sorted = [...samples].sort((left, right) => left - right);
const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
assert.ok(p95 < 16, `presentation render p95 ${p95.toFixed(3)}ms must be <16ms`);
process.stdout.write(`presentation benchmark: width=${WIDTH} samples=${samples.length} p95=${p95.toFixed(3)}ms\n`);
