import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TextOverlay, type OverlayAction } from "../lib/overlay.ts";

const theme = { fg: (_color: string, text: string) => text } as never;

it("keeps the inactive overlay golden byte-for-byte", () => {
	const overlay = new TextOverlay(
		theme,
		{ title: "BTW", lines: ["answer"], footer: "[c] copy · [Esc] close" },
		() => {},
	);
	assert.equal(overlay.render(20).join("\n"), [
		"╭──────────────────╮",
		"│ BTW              │",
		"│                  │",
		"│ answer           │",
		"│                  │",
		"│                  │",
		"│                  │",
		"│                  │",
		"│                  │",
		"│                  │",
		"│                  │",
		"│                  │",
		"│ [c] copy · [Esc]…│",
		"╰──────────────────╯",
	].join("\n"));
});

it("keeps active overlay lines inside live width/height budgets and sanitizes content", () => {
	let rows = 24;
	const overlay = new TextOverlay(
		theme,
		{
			title: "BTW 界面🙂\x1b[31mred",
			lines: Array.from({ length: 50 }, (_, index) => index === 0
				? "hostile\r\n\tbody\x00\x1b[31mred"
				: `第${index}行 🙂 é \x1b]8;;bad\x07link ${"long ".repeat(30)}`),
			footer: "[c] copy  [e] editor  [r] retry  [Esc] close",
		},
		() => {},
		() => {},
		{ active: true, ascii: false, getTerminalRows: () => rows },
	);
	for (const width of [40, 80, 120, 160]) {
		for (rows of [16, 20, 24]) {
			const lines = overlay.render(width);
			assert.ok(lines.length <= rows, `${width}x${rows} height`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${rows} width`);
			assert.ok(lines.every((line) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))));
			const plain = lines.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
			assert.doesNotMatch(plain, /\n(?:body|red)/);
			assert.ok(plain.split("\n").every((line) => /^[╭│╰]/.test(line)));
		}
	}
	rows = 24;
	const tall = overlay.render(80).length;
	rows = 16;
	const short = overlay.render(80).length;
	assert.ok(short < tall, "render reads terminal rows without remount");
	assert.match(overlay.render(40)[0] ?? "", /^╭/);

	const ascii = new TextOverlay(theme, { title: "BTW", lines: ["answer"] }, () => {}, () => {}, {
		active: true,
		ascii: true,
		getTerminalRows: () => 16,
	});
	assert.match(ascii.render(40)[0] ?? "", /^\+-/);
});

it("preserves active close/copy/editor/retry/scroll callbacks", () => {
	for (const [input, expected] of [["\x1b", "close"], ["q", "close"], ["c", "copy"], ["\r", "enter"], ["e", "extra"]] as const) {
		const actions: OverlayAction[] = [];
		const overlay = new TextOverlay(
			theme,
			{ title: "BTW", lines: ["answer"], extraKeys: [{ key: "e", action: "extra", hint: "editor" }] },
			(action) => actions.push(action),
			() => {},
			{ active: true, ascii: false, getTerminalRows: () => 16 },
		);
		overlay.handleInput(input);
		assert.deepEqual(actions, [expected]);
	}

	let redraws = 0;
	const overlay = new TextOverlay(
		theme,
		{ title: "BTW", lines: Array.from({ length: 40 }, (_, index) => `line ${index}`) },
		() => {},
		() => { redraws += 1; },
		{ active: true, ascii: false, getTerminalRows: () => 16 },
	);
	for (const input of ["j", "k", "\x1b[B", "\x1b[A", "\x1b[6~", "\x1b[5~"]) overlay.handleInput(input);
	assert.equal(redraws, 6);

	const blocked: OverlayAction[] = [];
	const staysOpen = new TextOverlay(theme, { title: "BTW", lines: [], onAction: (action) => { blocked.push(action); return false; } }, () => {
		throw new Error("done must not run");
	}, () => {}, { active: true, ascii: false, getTerminalRows: () => 16 });
	staysOpen.handleInput("c");
	assert.deepEqual(blocked, ["copy"]);
});
