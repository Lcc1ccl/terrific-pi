import assert from "node:assert/strict";
import { it } from "node:test";

import { selectTuiOption } from "../extensions/model-profile.ts";

it("does not open a custom picker for an empty option list", async () => {
	let customCalls = 0;
	const ctx = {
		mode: "tui",
		ui: {
			custom: async () => {
				customCalls += 1;
				return undefined;
			},
		},
	};

	const value = await selectTuiOption(ctx as never, "Empty", [], { cancelAction: "back" });
	assert.equal(value, undefined);
	assert.equal(customCalls, 0);
});

it("uses injected bindings for wrapping navigation and selection", async () => {
	let rendered = "";
	const value = await selectTuiOption({
		ui: {
			custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{
						matches: (data: string, binding: string) =>
							(data === "w" && binding === "tui.select.up")
							|| (data === "n" && binding === "tui.select.down")
							|| (data === "o" && binding === "tui.select.confirm")
							|| (data === "x" && binding === "tui.select.cancel"),
						getKeys: (binding: string) => ({
							"tui.select.up": ["w"],
							"tui.select.down": ["n"],
							"tui.select.confirm": ["o"],
							"tui.select.cancel": ["x"],
						}[binding] ?? []),
					},
					resolve,
				);
				rendered = component.render(100).join("\n");
				component.handleInput("w");
				component.handleInput("o");
				component.handleInput("x");
			}),
		},
	} as never, "Test", ["first", "second", "third"], { cancelAction: "back" });

	assert.equal(value, "third");
	assert.match(rendered, /W\/N navigate/);
	assert.match(rendered, /O select/);
	assert.match(rendered, /X back/);
});
