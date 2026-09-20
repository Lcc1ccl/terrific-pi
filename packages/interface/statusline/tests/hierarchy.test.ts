import assert from "node:assert/strict";
import { it } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../lib/config.ts";
import { formatContextBar, formatPathContent } from "../lib/format.ts";
import { fitSegmentsToWidth, renderStatusLine } from "../lib/render.ts";
import { buildWidgetSegments, PREVIEW_SNAPSHOT } from "../lib/widgets.ts";

it("keeps only identity anchors bold and separates cost from routine metadata", () => {
	const calls: Array<[string, string]> = [];
	const bold: string[] = [];
	const theme = {
		fg(color: string, text: string) { calls.push([color, text]); return text; },
		bold(text: string) { bold.push(text); return `\x1b[1m${text}\x1b[22m`; },
	};
	const config = { ...DEFAULT_CONFIG, lines: { ...DEFAULT_CONFIG.lines, line0: [], line1: ["path", "model", "branch", "cost", "fast", "state"] as const, line2: [] } };
	const value = { ...config, lines: { ...config.lines, line1: [...config.lines.line1] } };
	const rows = renderStatusLine(buildWidgetSegments(PREVIEW_SNAPSHOT, value), value, theme, 200, truncateToWidth, visibleWidth);
	assert.deepEqual([...new Set(bold)].sort(), ["model", "proj"]);
	assert.ok(calls.some(([c, t]) => c === "muted" && t === "/home/user/"));
	assert.ok(calls.some(([c, t]) => c === "text" && t === "main"));
	assert.ok(calls.some(([c, t]) => c === "muted" && t === "$"));
	assert.ok(calls.some(([c, t]) => c === "mdHeading" && t === "0.42"));
	assert.ok(calls.some(([c, t]) => c === "thinkingHigh" && t === " high"));
	assert.ok(calls.some(([c, t]) => c === "muted" && t === ""));
	assert.ok(calls.some(([c, t]) => c === "muted" && t === "Ready"));
	assert.ok(rows.every(row => visibleWidth(row) <= 200));
});

it("preserves the muted path glyph and bold tail after narrowing", () => {
	const config = { ...DEFAULT_CONFIG, lines: { ...DEFAULT_CONFIG.lines, line0: [], line1: ["path" as const], line2: [] } };
	const segments = buildWidgetSegments({ ...PREVIEW_SNAPSHOT, cwd: "/very/long/parent/project" }, config);
	const [fitted] = fitSegmentsToWidth(segments, config, { fg: (_, text) => text }, 16, visibleWidth, "");
	assert.match(fitted!.text, /^ ….*project$/);
	assert.equal(fitted!.parts![0]!.tone, "icon");
	assert.equal(fitted!.parts!.at(-1)!.bold, true);
	assert.equal(visibleWidth(fitted!.text) <= 16, true);
	assert.equal(segments[0]!.text, formatPathContent("/very/long/parent/project", "nerd").text);
});

it("preserves block bars and pressure semantics in both context modes", () => {
	assert.equal(formatContextBar(14, 8, "used", false, "nerd")!.text, " [█░░░░░░░] 14%");
	for (const mode of ["used", "remaining"] as const) {
		assert.equal(formatContextBar(82, 8, mode)!.parts.at(-1)!.tone, "warn");
		assert.equal(formatContextBar(92, 8, mode)!.parts.at(-1)!.tone, "error");
	}
});
