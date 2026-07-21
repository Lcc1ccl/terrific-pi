import assert from "node:assert/strict";
import { it } from "node:test";

import { selectSearchableOption } from "../lib/searchable-select.ts";

const items = [
	{
		value: "openai/gpt-5.6-luna",
		label: "openai/gpt-5.6-luna",
		searchText: "gpt-5.6-luna openai openai/gpt-5.6-luna Luna Research",
	},
	{
		value: "openai/gpt-5.6-sol",
		label: "openai/gpt-5.6-sol",
		searchText: "gpt-5.6-sol openai openai/gpt-5.6-sol Solar Coder",
	},
];

async function search(query: string, confirm: boolean) {
	let rendered = "";
	const result = await selectSearchableOption({
		ui: {
			custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{
						matches: (data: string, binding: string) =>
							(data === "\r" && binding === "tui.select.confirm")
							|| (data === "\x1b" && binding === "tui.select.cancel"),
						getKeys: () => [],
					},
					resolve,
				);
				for (const character of query) component.handleInput(character);
				rendered = component.render(100).join("\n");
				if (confirm) component.handleInput("\r");
				component.handleInput("\x1b");
			}),
		},
	} as never, "Models", items);
	return { result, rendered };
}

it("fuzzy-matches partial model ids and display names", async () => {
	const partialId = await search("5.6", false);
	assert.match(partialId.rendered, /gpt-5\.6-luna/);
	assert.match(partialId.rendered, /gpt-5\.6-sol/);
	assert.equal((await search("SOL", true)).result, "openai/gpt-5.6-sol");
	assert.equal((await search("research", true)).result, "openai/gpt-5.6-luna");

	const missing = await search("missing", false);
	assert.match(missing.rendered, /No matching models/);
});
