import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import statusline from "../extensions/statusline.ts";
import { DEFAULT_CONFIG } from "../lib/config.ts";

it("shows injected submit and cancel bindings for prefilled inputs", async () => {
	const configPath = join(mkdtempSync(join(tmpdir(), "statusline-input-hints-")), "statusline.json");
	writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG), "utf8");
	const previousPath = process.env.PI_STATUSLINE_CONFIG;
	process.env.PI_STATUSLINE_CONFIG = configPath;

	try {
		let command: { handler(args: string, ctx: unknown): Promise<void> } | undefined;
		statusline({
			events: { on() {} },
			on() {},
			registerCommand(_name: string, value: typeof command) { command = value; },
		} as never);

		const renders: string[] = [];
		const inputSequences = [
			["n", "\r"],
			["n", "n", "\r"],
			["q", "\x1b"],
			["q"],
			["q"],
		];
		await command!.handler("", {
			hasUI: true,
			mode: "tui",
			ui: {
				custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
					const component = factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{
							matches: (data: string, binding: string) =>
								(data === "n" && binding === "tui.select.down")
								|| (data === "o" && (binding === "tui.select.confirm" || binding === "tui.input.submit"))
								|| ((data === "q" || data === "\x1b") && binding === "tui.select.cancel"),
							getKeys: (binding: string) => ({
								"tui.select.up": ["w"],
								"tui.select.down": ["n"],
								"tui.select.confirm": ["o"],
								"tui.select.cancel": ["q"],
								"tui.input.submit": ["o"],
							}[binding] ?? []),
						},
						resolve,
					);
					renders.push(component.render(120).join("\n"));
					for (const input of inputSequences.shift() ?? ["q"]) component.handleInput(input);
				}),
				notify() {},
			},
		});

		const input = renders.find((rendered) => rendered.includes("spaces on each side"));
		assert.match(input ?? "", /O submit/);
		assert.match(input ?? "", /Q cancel/);
	} finally {
		if (previousPath === undefined) delete process.env.PI_STATUSLINE_CONFIG;
		else process.env.PI_STATUSLINE_CONFIG = previousPath;
	}
});
