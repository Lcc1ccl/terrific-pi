import assert from "node:assert/strict";
import { it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { WidgetsSetupComponent } from "../lib/widgets-setup.ts";

it("wraps widget navigation and renders the injected keybinding labels", () => {
	const bindings = {
		matches: (data: string, binding: string) => data === "p" && binding === "tui.select.up",
		getKeys: (binding: string) => ({
			"tui.select.up": ["p"],
			"tui.select.down": ["n"],
			"tui.select.confirm": ["enter"],
			"tui.select.cancel": ["escape"],
			"tui.editor.cursorLeft": ["h"],
			"tui.editor.cursorRight": ["l"],
		}[binding] ?? []),
	};
	const component = new WidgetsSetupComponent({
		title: "Widgets",
		allWidgets: ["path", "tokens"],
		enabled: ["path"],
		theme: { fg: (_color, text) => text },
		previewConfig: { ...DEFAULT_CONFIG, widgets: ["path"] },
		keybindings: bindings as never,
		onChange: () => true,
		done() {},
		requestRender() {},
	});

	component.handleInput("p");
	const rendered = component.render(120).join("\n");
	assert.match(rendered, /› \[ \] tokens/);
	assert.match(rendered, /P\/N select/);
	assert.match(rendered, /H\/L move/);
	assert.match(rendered, /Enter done/);
	assert.match(rendered, /Esc back/);
});
