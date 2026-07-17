import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { DARK_PALETTE, renderStatusLine } from "../lib/render.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const segments = [
	{ id: "path" as const, accent: "path" as const, text: "left" },
	{ id: "state" as const, accent: "state" as const, text: "right" },
];

function render(spacing: number, legacySeparator = ""): string {
	const config = {
		...DEFAULT_CONFIG,
		spacing,
		separator: legacySeparator,
	};
	return renderStatusLine(segments, config, DARK_PALETTE, 200, (text) => text)
		.replace(ANSI_PATTERN, "");
}

describe("renderStatusLine widget spacing", () => {
	it("keeps the fixed separator and adds equal spaces on both sides", () => {
		assert.equal(render(2, "|"), "  left  ·  right");
	});

	it("keeps the separator when spacing is zero", () => {
		assert.equal(render(0), "  left·right");
	});
});
