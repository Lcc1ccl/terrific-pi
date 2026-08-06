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
	it("renders any widget assigned to line0 in configured order", () => {
		const value = config({
			line0: ["tokens", "path"],
			line1: ["model"],
			line2: [],
			line3: [],
			line4: ["state"],
		});
		assert.equal(
			renderEditorStatus(segments, value, theme, 80, truncate),
			"in 10 · out 5 · ~/proj",
		);
	});

	it("renders line1-line4 independently without semantic classification", () => {
		const value = config({
			line0: ["tokens"],
			line1: ["state", "path"],
			line2: [],
			line3: ["model"],
			line4: [],
		});
		assert.deepEqual(
			renderStatusLine(segments, value, theme, 80, truncate),
			["  Ready · ~/proj", "  gpt-5 high"],
		);
	});

	it("can include line0 as the first footer row when the editor bridge is unavailable", () => {
		const value = config({
			line0: ["tokens"],
			line1: ["path"],
			line2: [],
			line3: [],
			line4: [],
		});
		assert.deepEqual(
			renderStatusLine(segments, value, theme, 80, truncate, undefined, true),
			["  in 10 · out 5", "  ~/proj"],
		);
	});
});
