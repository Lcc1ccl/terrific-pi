import assert from "node:assert/strict";
import { it } from "node:test";

import { selectMenu } from "../lib/select-menu.ts";

function createKeybindings() {
	const bindings = {
		"\x1b[A": "tui.select.up",
		"\x1b[B": "tui.select.down",
		"\r": "tui.select.confirm",
		"\x1b": "tui.select.cancel",
	} as const;
	return {
		matches: (data: string, binding: string) => bindings[data as keyof typeof bindings] === binding,
		getKeys: (binding: string) => ({
			"tui.select.up": ["up"],
			"tui.select.down": ["down"],
			"tui.select.confirm": ["enter"],
			"tui.select.cancel": ["escape"],
		}[binding] ?? []),
	};
}

async function choose(inputs: string[], cancelAction: "back" | "cancel" = "cancel") {
	let rendered = "";
	let customCalls = 0;
	const ctx = {
		mode: "tui",
		ui: {
			select: async () => {
				throw new Error("TUI menu must not fall back to ctx.ui.select");
			},
			custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
				customCalls += 1;
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					createKeybindings(),
					resolve,
				);
				rendered = component.render(100).join("\n");
				for (const input of inputs) component.handleInput(input);
			}),
		},
	};
	const value = await selectMenu(ctx as never, "Test menu", ["first", "second", "third"], { cancelAction });
	return { value, rendered, customCalls, ctx };
}

it("wraps menu navigation, labels cancel scope, and safely ignores an empty list", async () => {
	assert.equal((await choose(["\x1b[A", "\r"])).value, "third");
	assert.equal((await choose(["\x1b[B", "\x1b[B", "\x1b[B", "\r"])).value, "first");

	const cancelled = await choose(["\x1b"], "back");
	assert.equal(cancelled.value, undefined);
	assert.match(cancelled.rendered, /Up\/Down navigate/);
	assert.match(cancelled.rendered, /Enter select/);
	assert.match(cancelled.rendered, /Esc back/);

	let customCalls = 0;
	const empty = await selectMenu({
		mode: "tui",
		ui: {
			select: async () => undefined,
			custom: async () => {
				customCalls += 1;
				return undefined;
			},
		},
	} as never, "Empty", []);
	assert.equal(empty, undefined);
	assert.equal(customCalls, 0);
});
