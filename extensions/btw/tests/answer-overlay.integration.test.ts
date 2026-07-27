import assert from "node:assert/strict";
import { it } from "node:test";

import { showAnswer } from "../extensions/btw.ts";

it("keeps active answer overlay close/editor/retry return actions", async () => {
	for (const [input, expected] of [["\x1b", "close"], ["e", "editor"], ["r", "retry"]] as const) {
		let rendered = "";
		const result = await showAnswer({
			ui: {
				custom: async (factory: any) => new Promise((resolve) => {
					const component = factory(
						{ terminal: { rows: 16 }, requestRender() {} },
						{ fg: (_color: string, text: string) => text },
						{},
						resolve,
					);
					rendered = component.render(40).join("\n");
					component.handleInput(input);
				}),
				notify() {},
			},
		} as never, "question", "answer", "provider/model", { active: true, ascii: false });
		assert.equal(result, expected);
		assert.match(rendered, /^╭─ BTW · provider\/model/);
	}
});
