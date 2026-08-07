import assert from "node:assert/strict";
import { it } from "node:test";

import { DEFAULT_CONFIG } from "../lib/config.ts";
import { WidgetsSetupComponent } from "../lib/widgets-setup.ts";
import type { WidgetLines } from "../lib/types.ts";

function lines(partial: Partial<WidgetLines>): WidgetLines {
	return { line0: [], line1: [], line2: [], line3: [], line4: [], ...partial };
}

it("renders all five lines and moves disabled widgets before enabling them", () => {
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
	const changes: WidgetLines[] = [];
	const configured = lines({ line1: ["path"] });
	const component = new WidgetsSetupComponent({
		title: "Widgets by LINE",
		allWidgets: ["path", "tokens"],
		lines: configured,
		theme: { fg: (_color, text) => text },
		previewConfig: { ...DEFAULT_CONFIG, lines: configured },
		keybindings: bindings as never,
		onChange: (next) => { changes.push(next); return true; },
		done() {},
		requestRender() {},
	});

	component.handleInput("p");
	let rendered = component.render(120).join("\n");
	assert.match(rendered, /› \[ \] tokens/);
	for (let index = 0; index <= 4; index++) assert.match(rendered, new RegExp(`LINE${index}`));
	assert.match(rendered, /P\/N select/);
	assert.match(rendered, /H\/L move/);
	assert.match(rendered, /Enter done/);
	assert.match(rendered, /Esc back/);

	component.handleInput("g");
	rendered = component.render(120).join("\n");
	assert.match(rendered, /— LINE2 —[\s\S]*› \[ \] tokens/);

	component.handleInput(" ");
	assert.deepEqual(changes.at(-1), lines({ line1: ["path"], line2: ["tokens"] }));
});

it("reopens disabled widgets on their persisted lines", () => {
	const configured = lines({ line1: ["path"] });
	const component = new WidgetsSetupComponent({
		title: "Widgets by LINE",
		allWidgets: ["model", "path"],
		lines: configured,
		widgetOrder: lines({ line0: ["model"], line1: ["path"] }),
		theme: { fg: (_color, text) => text },
		previewConfig: { ...DEFAULT_CONFIG, lines: configured },
		keybindings: { matches: () => false } as never,
		onChange: () => true,
		done() {},
		requestRender() {},
	});

	assert.match(component.render(120).join("\n"), /— LINE0 —[\s\S]*\[ \] model[\s\S]*— LINE1 —[\s\S]*\[x\] path/);
});

it("rolls back a rejected cross-line move", () => {
	const configured = lines({ line0: ["model"], line1: ["path"] });
	const component = new WidgetsSetupComponent({
		title: "Widgets by LINE",
		allWidgets: ["model", "path"],
		lines: configured,
		theme: { fg: (_color, text) => text },
		previewConfig: { ...DEFAULT_CONFIG, lines: configured },
		keybindings: {
			matches: (data: string, binding: string) => data === "right" && binding === "tui.editor.cursorRight",
		} as never,
		onChange: () => false,
		done() {},
		requestRender() {},
	});

	component.handleInput("right");
	const rendered = component.render(120).join("\n");
	assert.match(rendered, /— LINE0 —[\s\S]*› \[x\] model/);
	assert.match(rendered, /Change was not saved/);
});

it("returns current lines on confirm and undefined on cancel", () => {
	const configured = lines({ line0: ["model"], line4: ["state"] });
	const results: Array<WidgetLines | undefined> = [];
	const make = () => new WidgetsSetupComponent({
		title: "Widgets by LINE",
		allWidgets: ["model", "state"],
		lines: configured,
		theme: { fg: (_color, text) => text },
		previewConfig: { ...DEFAULT_CONFIG, lines: configured },
		keybindings: {
			matches: (data: string, binding: string) =>
				(data === "confirm" && binding === "tui.select.confirm")
				|| (data === "cancel" && binding === "tui.select.cancel"),
		} as never,
		onChange: () => true,
		done: (value) => results.push(value),
		requestRender() {},
	});

	make().handleInput("confirm");
	make().handleInput("cancel");
	assert.deepEqual(results, [configured, undefined]);
});
