import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TextOverlay } from "../lib/overlay.ts";

it("keeps overlay lines within the viewport and redraws on scroll", () => {
	let redraws = 0;
	const theme = { fg: (_color: string, text: string) => text } as never;
	const overlay = new TextOverlay(
		theme,
		{ title: "Test", lines: Array.from({ length: 30 }, (_, index) => `line ${index}`) },
		() => {},
		() => { redraws += 1; },
	);
	assert.ok(overlay.render(20).every((line) => visibleWidth(line) <= 20));
	overlay.handleInput("j");
	assert.equal(redraws, 1);
	overlay.invalidate();
});
