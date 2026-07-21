import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";

export interface SelectMenuItem {
	value: string;
	label?: string;
	description?: string;
}

export type SelectMenuOption = string | SelectMenuItem;

export type SelectMenuOptions = {
	cancelAction?: "back" | "cancel";
	maxVisible?: number;
};

function displayKey(key: string): string {
	return ({ up: "Up", down: "Down", enter: "Enter", escape: "Esc" }[key] ?? key.replace(/\b[a-z]/g, (char) => char.toUpperCase()));
}

export function selectMenu(
	ctx: ExtensionContext,
	title: string,
	options: readonly SelectMenuOption[],
	settings: SelectMenuOptions = {},
): Promise<string | undefined> {
	if (options.length === 0) return Promise.resolve(undefined);
	const items = options.map((option) => typeof option === "string"
		? { value: option, label: option, description: undefined }
		: { value: option.value, label: option.label ?? option.value, description: option.description });
	if (ctx.mode !== "tui") {
		return ctx.ui.select(title, items.map((item) => item.label)).then((label) =>
			items.find((item) => item.label === label)?.value);
	}

	const cancelAction = settings.cancelAction ?? (items.some((item) => item.value === "Back") ? "back" : "cancel");
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const key = (binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel", fallback: string) =>
			displayKey(keybindings.getKeys?.(binding)[0] ?? fallback);
		const list = new SelectList(
			items.map(({ value, label }) => ({ value, label })),
			Math.min(items.length, settings.maxVisible ?? 10),
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		);
		let selectedIndex = 0;
		const tip = new Text("", 1, 0);
		const updateTip = () => tip.setText(items[selectedIndex]?.description
			? theme.fg("muted", `Tip: ${items[selectedIndex]!.description}`)
			: "");
		updateTip();
		const select = () => done(items[selectedIndex]?.value);
		const move = (direction: -1 | 1) => {
			selectedIndex = (selectedIndex + direction + items.length) % items.length;
			list.setSelectedIndex(selectedIndex);
			updateTip();
		};
		const hint = [
			`${key("tui.select.up", "up")}/${key("tui.select.down", "down")} navigate`,
			`${key("tui.select.confirm", "enter")} select`,
			`${key("tui.select.cancel", "escape")} ${cancelAction}`,
		].join(" · ");
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(list);
		container.addChild(tip);
		container.addChild(new Text(theme.fg("dim", hint), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (keybindings.matches(data, "tui.select.up")) move(-1);
				else if (keybindings.matches(data, "tui.select.down")) move(1);
				else if (keybindings.matches(data, "tui.select.confirm") || data === "\n" || data === "\r") select();
				else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
				tui.requestRender();
			},
		};
	});
}
