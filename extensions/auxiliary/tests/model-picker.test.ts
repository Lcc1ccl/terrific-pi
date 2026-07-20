import assert from "node:assert/strict";
import { it } from "node:test";

import { pickAvailableModel } from "../lib/configure.ts";

it("shows filtering and keybinding hints in the auxiliary model picker", async () => {
	const models = [
		{ provider: "openai", id: "gpt-a", name: "GPT A" },
		{ provider: "openai", id: "gpt-b", name: "GPT B" },
	];
	let rendered = "";
	const ctx = {
		mode: "print",
		model: models[1],
		modelRegistry: {
			find(provider: string, id: string) {
				return models.find((model) => model.provider === provider && model.id === id);
			},
		},
		ui: {
			select: async (_title: string, options: string[]) => options[0],
			custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{
						matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\x1b",
						getKeys: (binding: string) => ({
							"tui.select.up": ["up"],
							"tui.select.down": ["down"],
							"tui.select.confirm": ["enter"],
							"tui.select.cancel": ["escape"],
						}[binding] ?? []),
					},
					resolve,
				);
				rendered = component.render(100).join("\n");
				component.handleInput("\x1b");
			}),
			notify() {},
		},
	};

	assert.equal(await pickAvailableModel(ctx as never, "Model", "current", ["openai/gpt-a", "openai/gpt-b"]), undefined);
	assert.match(rendered, /type to filter/);
	assert.match(rendered, /Up\/Down navigate/);
	assert.match(rendered, /Enter select/);
	assert.match(rendered, /Esc back/);
});

it("uses injected bindings to navigate and select filtered models", async () => {
	const models = [
		{ provider: "openai", id: "gpt-a", name: "GPT A" },
		{ provider: "openai", id: "gpt-b", name: "GPT B" },
	];
	let rendered = "";
	const ctx = {
		mode: "print",
		model: models[0],
		modelRegistry: {
			find(provider: string, id: string) {
				return models.find((model) => model.provider === provider && model.id === id);
			},
		},
		ui: {
			select: async (_title: string, options: string[]) => options[0],
			custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{
						matches: (data: string, binding: string) =>
							(data === "w" && binding === "tui.select.up")
							|| (data === "n" && binding === "tui.select.down")
							|| (data === "o" && binding === "tui.select.confirm")
							|| ((data === "x" || data === "\x1b") && binding === "tui.select.cancel"),
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
				component.handleInput("n");
				component.handleInput("o");
				component.handleInput("x");
				component.handleInput("\x1b");
			}),
			notify() {},
		},
	};

	assert.equal(await pickAvailableModel(ctx as never, "Model", "current", ["openai/gpt-a", "openai/gpt-b"]), "openai/gpt-b");
	assert.match(rendered, /W\/N navigate/);
	assert.match(rendered, /O select/);
	assert.match(rendered, /X back/);
});
