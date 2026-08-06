import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";

function displayKey(key: string): string {
	return ({ up: "Up", down: "Down", enter: "Enter", escape: "Esc" }[key] ?? key.replace(/\b[a-z]/g, (char) => char.toUpperCase()));
}

export function selectMenu(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
	if (options.length === 0) return Promise.resolve(undefined);
	if (ctx.mode !== "tui") return ctx.ui.select(title, options);
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const key = (binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel", fallback: string) =>
			displayKey(keybindings.getKeys?.(binding)[0] ?? fallback);
		const list = new SelectList(options.map((value) => ({ value, label: value })), Math.min(options.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		let selectedIndex = 0;
		const move = (direction: -1 | 1) => {
			selectedIndex = (selectedIndex + direction + options.length) % options.length;
			list.setSelectedIndex(selectedIndex);
		};
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", [
			`${key("tui.select.up", "up")}/${key("tui.select.down", "down")} navigate`,
			`${key("tui.select.confirm", "enter")} select`,
			`${key("tui.select.cancel", "escape")} cancel`,
		].join(" · ")), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (keybindings.matches(data, "tui.select.up")) move(-1);
				else if (keybindings.matches(data, "tui.select.down")) move(1);
				else if (keybindings.matches(data, "tui.select.confirm") || data === "\n" || data === "\r") done(options[selectedIndex]);
				else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
				tui.requestRender();
			},
		};
	});
}
