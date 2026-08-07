import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { renderEditorStatus, renderStatusLine } from "../lib/render.ts";
import type { StatuslineConfig, WidgetSegment } from "../lib/types.ts";

const theme = { fg: (_color: string, text: string) => text };
const truncate = (text: string, width: number) => text.slice(0, width);
const segments: WidgetSegment[] = [
	{ id: "state", accent: "state", text: "Ready" },
	{ id: "tokens", accent: "usage", text: "in 10 · out 5" },
	{ id: "path", accent: "path", text: "~/proj" },
	{ id: "model", accent: "model", text: "gpt-5 high" },
];

function config(lines: StatuslineConfig["lines"]): StatuslineConfig {
	return { ...DEFAULT_CONFIG, lines };
}

describe("explicit widget lines", () => {
	it("renders LINE0 and LINE1 independently for the editor bridge", () => {
		const value = config({
			line0: ["tokens", "path"],
			line1: ["model"],
			line2: [],
			line3: [],
			line4: ["state"],
		});
		const renderLine = renderEditorStatus as unknown as (
			segments: WidgetSegment[],
			config: StatuslineConfig,
			themeArg: typeof theme,
			width: number,
			truncateArg: typeof truncate,
			measure: undefined,
			line: "line0" | "line1",
		) => string;
		assert.equal(renderLine(segments, value, theme, 80, truncate, undefined, "line0"), "in 10 · out 5 · ~/proj");
		assert.equal(renderLine(segments, value, theme, 80, truncate, undefined, "line1"), "gpt-5 high");
	});

	it("renders line2-line4 as footer rows while the editor owns LINE0 and LINE1", () => {
		const value = config({
			line0: ["tokens"],
			line1: ["state", "path"],
			line2: [],
			line3: ["model"],
			line4: [],
		});
		const renderFooter = renderStatusLine as unknown as (...args: unknown[]) => string[];
		assert.deepEqual(
			renderFooter(segments, value, theme, 80, truncate, undefined, "line2"),
			["  gpt-5 high"],
		);
	});

	it("renders all five lines in order when the editor bridge is unavailable", () => {
		const value = config({
			line0: ["tokens"],
			line1: ["path"],
			line2: [],
			line3: [],
			line4: [],
		});
		const renderFooter = renderStatusLine as unknown as (...args: unknown[]) => string[];
		assert.deepEqual(
			renderFooter(segments, value, theme, 80, truncate, undefined, "line0"),
			["  in 10 · out 5", "  ~/proj"],
		);
	});
});
