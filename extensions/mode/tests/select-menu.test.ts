import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { selectMenu } from "../lib/select-menu.ts";

function createKeybindings(remapped = false) {
	const bindings = {
		"\x1b[A": "tui.select.up",
		"\x1b[B": "tui.select.down",
		"\r": "tui.select.confirm",
		"\x1b": "tui.select.cancel",
	} as const;
	return {
		matches: (data: string, binding: string) => {
			const remappedBindings: Record<string, string> = remapped ? {
				k: "tui.select.up",
				j: "tui.select.down",
				" ": "tui.select.confirm",
				"\x03": "tui.select.cancel",
			} : {};
			return remappedBindings[data] === binding || bindings[data as keyof typeof bindings] === binding;
		},
		getKeys: (binding: string) => remapped ? ({
			"tui.select.up": ["k"], "tui.select.down": ["j"], "tui.select.confirm": ["space"], "tui.select.cancel": ["ctrl+c"],
		}[binding] ?? []) : ({
			"tui.select.up": ["up"], "tui.select.down": ["down"], "tui.select.confirm": ["enter"], "tui.select.cancel": ["escape"],
		}[binding] ?? []),
	};
}

async function choose(
	inputs: Array<string | (() => void)>,
	settings: { cancelAction?: "back" | "cancel"; maxVisible?: number } = {},
	options = ["first", "second", "third"],
	appearance = { active: false, ascii: false },
	width = 100,
	rows: number | { value: number } = 24,
	remapped = false,
) {
	let rendered = "";
	const renders: string[] = [];
	let customCalls = 0;
	const ctx = {
		mode: "tui",
		ui: {
			select: async () => { throw new Error("TUI menu must not fall back to ctx.ui.select"); },
			custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
				customCalls += 1;
				let component: any;
				const tui = {
					terminal: { get rows() { return typeof rows === "number" ? rows : rows.value; } },
					requestRender() { rendered = component.render(width).join("\n"); renders.push(rendered); },
				};
				component = factory(
					tui,
					{ fg: (color: string, text: string) => appearance.active ? `\x1b[${color === "accent" ? "36" : color === "muted" ? "2" : "0"}m${text}\x1b[0m` : text, bold: (text: string) => text },
					createKeybindings(remapped),
					resolve,
				);
				rendered = component.render(width).join("\n");
				renders.push(rendered);
				for (const input of inputs) {
					if (typeof input === "function") input();
					else component.handleInput(input);
				}
			}),
		},
	};
	const value = await (selectMenu as any)(ctx, "Test menu\nsupporting line", options, settings, appearance);
	return { value, rendered, renders, customCalls, ctx };
}

it("keeps the inactive renderer byte-for-byte and existing navigation behavior", async () => {
	assert.equal((await choose(["\x1b[A", "\r"])).value, "third");
	assert.equal((await choose(["\x1b[B", "\x1b[B", "\x1b[B", "\r"])).value, "first");
	const golden = await choose(["\x1b"], { cancelAction: "back" }, ["first", "second — detail"], { active: false, ascii: false }, 40);
	assert.equal(golden.value, undefined);
	assert.equal(golden.rendered, [
		"────────────────────────────────────────",
		" Test menu                              ",
		" supporting line                        ",
		"→ first",
		"  second — detail",
		" Up/Down navigate · Enter select · Esc  ",
		" back                                   ",
		"────────────────────────────────────────",
	].join("\n"));

	let customCalls = 0;
	const empty = await selectMenu({ mode: "tui", ui: { select: async () => undefined, custom: async () => { customCalls += 1; return undefined; } } } as never, "Empty", []);
	assert.equal(empty, undefined);
	assert.equal(customCalls, 0);
});

it("renders active menus safely at the width/height matrix with rebound hints and ASCII fallback", async () => {
	const options = ["primary — muted detail", `界面🙂 ${"long ".repeat(50)}\x1b[31mred`, "hostile\r\n\trow\x00 — detail\nline"];
	for (const width of [40, 80, 120, 160]) {
		for (const rows of [16, 20, 24]) {
			const result = await choose(["\x1b"], { cancelAction: "back" }, options, { active: true, ascii: false }, width, rows, true);
			const lines = result.rendered.split("\n");
			assert.ok(lines.length <= rows, `${width}x${rows} line budget`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${rows} width budget`);
			assert.match(result.rendered, /\x1b\[36mprimary\x1b\[0m/);
			assert.match(result.rendered, /\x1b\[2m — muted detail\x1b\[0m/);
			assert.match(result.rendered, /K\/J.*Space.*Ctrl\+C/);
			if (width >= 80) assert.match(result.rendered, /K\/J navigate.*Space select.*Ctrl\+C back/);
			assert.doesNotMatch(result.rendered, /\x1b\[31m/);
			const plain = result.rendered.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
			assert.doesNotMatch(plain, /\n(?:row|line)/);
			assert.ok(plain.split("\n").every((line) => /^[╭│╰]/.test(line)));
		}
	}
	const liveRows = { value: 24 };
	const resized = await choose([() => { liveRows.value = 16; }, "\x1b"], { maxVisible: 20 }, Array.from({ length: 12 }, (_, index) => `item ${index}`), { active: true, ascii: false }, 80, liveRows);
	assert.ok(resized.renders[0]!.split("\n").length > resized.rendered.split("\n").length);

	const ascii = await choose(["\x1b"], {}, options, { active: true, ascii: true }, 40, 16);
	const plainAscii = ascii.rendered.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	assert.match(plainAscii, /^\+-/);
	assert.match(plainAscii, /\| >/);
});

it("labels active top-level cancel as close and explicit secondary cancel as back", async () => {
	const top = await choose(["\x03"], {}, ["first", "second"], { active: true, ascii: false }, 80, 24, true);
	assert.match(top.rendered, /Ctrl\+C close/);
	assert.doesNotMatch(top.rendered, /Ctrl\+C cancel/);

	const secondary = await choose(["\x03"], { cancelAction: "back" }, ["first", "second"], { active: true, ascii: false }, 80, 24, true);
	assert.match(secondary.rendered, /Ctrl\+C back/);
});

it("filters sanitized primary-label prefixes and supports Kitty/Unicode input", async () => {
	const options = [
		"alpha — needle only in description",
		"xneedle — non-prefix",
		"Needleman — prefix one",
		"needlework — prefix two",
		"\x1b[31mNeedleansi\x1b[0m — sanitized prefix",
		"界面 view — unicode",
		"two words — space",
		...Array.from({ length: 5 }, (_, index) => `other-${index} — filler`),
	];
	const negative = await choose(["n", "e", "e", "d", "l", "e", "\r"], {}, options, { active: true, ascii: false });
	assert.equal(negative.value, "Needleman — prefix one");
	assert.ok(negative.renders.some((render) => !render.includes("alpha —") && !render.includes("xneedle —")));

	const cycled = await choose(["\x1b[78u", "e", "e", "d", "l", "e", "\x1b[B", "\r"], {}, options, { active: true, ascii: false });
	assert.equal(cycled.value, "needlework — prefix two");
	const kittyBackspace = await choose(["\x1b[122u", "\x1b[127u", "界", "\r"], {}, options, { active: true, ascii: false });
	assert.equal(kittyBackspace.value, "界面 view — unicode");
	const legacyBackspace = await choose(["z", "\x7f", "界", "\r"], {}, options, { active: true, ascii: false });
	assert.equal(legacyBackspace.value, "界面 view — unicode");
	for (const [emoji, backspace] of [
		["🙂", "\x7f"],
		["🙂", "\x1b[127u"],
		["\x1b[128578u", "\x7f"],
		["\x1b[128578u", "\x1b[127u"],
	]) {
		const emojiBackspace = await choose([emoji!, backspace!, "界", "\r"], {}, options, { active: true, ascii: false });
		assert.equal(emojiBackspace.value, "界面 view — unicode");
	}
	const sanitized = await choose(["n", "e", "e", "d", "l", "e", "a", "n", "s", "i", "\r"], {}, options, { active: true, ascii: false });
	assert.equal(sanitized.value, "\x1b[31mNeedleansi\x1b[0m — sanitized prefix");
	const kittySpace = await choose(["t", "w", "o", "\x1b[32u", "w", "\r"], {}, options, { active: true, ascii: false });
	assert.equal(kittySpace.value, "two words — space");
	const rawSpace = await choose(["t", "w", "o", " ", "w", "\r"], {}, options, { active: true, ascii: false });
	assert.equal(rawSpace.value, "two words — space");

	const boundSpace = await choose([" "], {}, options, { active: true, ascii: false }, 100, 24, true);
	assert.equal(boundSpace.value, "alpha — needle only in description");
	assert.doesNotMatch(boundSpace.rendered, /Filter:  /);
	const short = await choose(["\x1b[122u", "界", "\r"], {}, ["first", "second"], { active: true, ascii: false });
	assert.equal(short.value, "first");
	assert.doesNotMatch(short.rendered, /Filter:/);
});
