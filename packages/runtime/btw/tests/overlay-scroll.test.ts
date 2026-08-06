import assert from "node:assert/strict";
import { it } from "node:test";

import { TextOverlay } from "../lib/overlay.ts";

it("shows a scroll hint only when BTW overlay content overflows", () => {
	const theme = { fg: (_color: string, text: string) => text } as never;
	const footer = "[c] copy · [Esc] close";
	const short = new TextOverlay(theme, { title: "BTW", lines: ["answer"], footer }, () => {});
	const long = new TextOverlay(
		theme,
		{ title: "BTW", lines: Array.from({ length: 30 }, (_, index) => `line ${index}`), footer },
		() => {},
	);

	assert.doesNotMatch(short.render(100).join("\n"), /scroll/);
	assert.match(long.render(100).join("\n"), /Up\/Down scroll/);
});
