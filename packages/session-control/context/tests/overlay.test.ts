import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TextOverlay, type OverlayAction } from "../lib/overlay.ts";

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

it("keeps copy on c and exposes compaction as a separate action", () => {
	const actions: OverlayAction[] = [];
	const theme = { fg: (_color: string, text: string) => text } as never;
	const overlay = new TextOverlay(
		theme,
		{
			title: "Context",
			lines: ["summary"],
			extraKeys: [{ key: "x", action: "extra", hint: "compact" }],
		},
		(action) => actions.push(action),
	);

	overlay.handleInput("c");
	overlay.handleInput("x");
	assert.deepEqual(actions, ["copy", "extra"]);
});
