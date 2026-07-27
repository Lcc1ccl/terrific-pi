import assert from "node:assert/strict";
import { test } from "node:test";

import { ProfileOrderComponent } from "../lib/profile-order.ts";
import type { ModelProfile } from "../lib/types.ts";

function profile(id: string, alias: string): ModelProfile {
	return {
		id,
		alias,
		provider: "openai",
		model: `gpt-${alias}`,
		thinking: "medium",
		hotkey: `alt+${id}`,
	};
}

test("profile order uses arrows to select and move rows", () => {
	let saved: ModelProfile[] | undefined;
	let renders = 0;
	const bindings = {
		matches: (data: string, binding: string) => ({
			up: "tui.select.up",
			down: "tui.select.down",
			left: "tui.editor.cursorLeft",
			right: "tui.editor.cursorRight",
			enter: "tui.select.confirm",
			escape: "tui.select.cancel",
		}[data] === binding),
		getKeys: (binding: string) => [binding.split(".").at(-1)!],
	};
	const component = new ProfileOrderComponent({
		profiles: [profile("1", "one"), profile("2", "two"), profile("3", "three")],
		theme: { fg: (_color, text) => text },
		keybindings: bindings as never,
		done: (profiles) => { saved = profiles; },
		requestRender: () => { renders += 1; },
	});

	component.handleInput("down");
	component.handleInput("right");
	assert.match(component.render(120).join("\n"), /› Alt\+3  two/);
	component.handleInput("enter");

	assert.deepEqual(saved?.map(({ alias }) => alias), ["one", "three", "two"]);
	assert.equal(renders, 2);
});
