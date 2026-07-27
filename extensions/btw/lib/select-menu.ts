import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, decodeKittyPrintable, Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type SelectMenuOptions = {
	cancelAction?: "back" | "cancel";
	maxVisible?: number;
};

export interface MenuAppearance {
	active: boolean;
	ascii: boolean;
}

function displayKey(key: string): string {
	return ({ up: "Up", down: "Down", enter: "Enter", escape: "Esc", space: "Space" }[key]
		?? key.replace(/\b[a-z]/g, (char) => char.toUpperCase()));
}

function sanitize(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function primaryLabel(option: string): string {
	const clean = sanitize(option);
	const separator = clean.indexOf(" — ");
	return separator < 0 ? clean : clean.slice(0, separator);
}

function printableInput(data: string): string | undefined {
	const value = decodeKittyPrintable(data) ?? ([...data].length === 1 ? data : undefined);
	return value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : undefined;
}

function activeMenu(
	tui: { terminal?: { rows?: number }; requestRender(): void },
	theme: { fg(token: string, text: string): string; bold(text: string): string },
	keybindings: { matches(data: string, binding: string): boolean; getKeys?(binding: string): string[] },
	done: (value: string | undefined) => void,
	title: string,
	options: string[],
	settings: SelectMenuOptions,
	appearance: MenuAppearance,
) {
	const cancelAction = settings.cancelAction ?? (options.includes("Back") ? "back" : "close");
	const filterable = options.length > 10;
	let filter = "";
	let selectedIndex = 0;
	const key = (binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel", fallback: string) =>
		displayKey(keybindings.getKeys?.(binding)[0] ?? fallback);
	const glyph = appearance.ascii
		? { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", selected: ">", separator: "." }
		: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│", selected: "●", separator: "·" };
	const filtered = () => filter
		? options.filter((option) => primaryLabel(option).toLocaleLowerCase().startsWith(filter.toLocaleLowerCase()))
		: options;
	const move = (direction: -1 | 1) => {
		const matches = filtered();
		if (matches.length === 0) return;
		selectedIndex = (selectedIndex + direction + matches.length) % matches.length;
	};
	const select = () => {
		const value = filtered()[selectedIndex];
		if (value !== undefined) done(value);
	};

	return {
		render(width: number): string[] {
			if (width <= 0) return [];
			const titleLines = title.split("\n").map(sanitize);
			if (width < 4) return [truncateToWidth(titleLines[0] ?? "", width, "")];
			const inner = width - 2;
			const border = (left: string, right: string, label = "") => {
				const clean = truncateToWidth(label, Math.max(0, inner - 2), "…");
				const prefix = clean ? `${glyph.horizontal} ${clean} ` : "";
				return theme.fg("border", left + prefix + glyph.horizontal.repeat(Math.max(0, inner - visibleWidth(prefix))) + right);
			};
			const row = (content: string) => theme.fg("border", glyph.vertical) + truncateToWidth(content, inner, "…", true) + theme.fg("border", glyph.vertical);
			const lines = [border(glyph.topLeft, glyph.topRight, titleLines[0] ?? "")];
			for (const supporting of titleLines.slice(1)) lines.push(row(` ${theme.fg("muted", supporting)}`));
			if (filterable) lines.push(row(` ${theme.fg("dim", `Filter: ${filter || "type to filter"}`)}`));
			const matches = filtered();
			if (selectedIndex >= matches.length) selectedIndex = 0;
			const rows = Math.max(1, tui.terminal?.rows ?? 24);
			const chrome = lines.length + 2;
			const visibleCount = Math.max(1, Math.min(settings.maxVisible ?? 10, rows - chrome, Math.max(1, matches.length)));
			const start = Math.max(0, Math.min(selectedIndex - visibleCount + 1, matches.length - visibleCount));
			if (matches.length === 0) lines.push(row(` ${theme.fg("warning", "No matches")}`));
			else for (let index = start; index < Math.min(matches.length, start + visibleCount); index += 1) {
				const option = sanitize(matches[index]!);
				const separator = option.indexOf(" — ");
				const primary = separator < 0 ? option : option.slice(0, separator);
				const description = separator < 0 ? "" : option.slice(separator + 3);
				const selected = index === selectedIndex;
				const marker = selected ? glyph.selected : " ";
				const styledPrimary = selected ? theme.fg("accent", primary) : primary;
				const styledDescription = description ? theme.fg("muted", ` — ${description}`) : "";
				lines.push(row(` ${marker} ${styledPrimary}${styledDescription}`));
			}
			const fullHint = [
				`${key("tui.select.up", "up")}/${key("tui.select.down", "down")} navigate`,
				`${key("tui.select.confirm", "enter")} select`,
				`${key("tui.select.cancel", "escape")} ${cancelAction}`,
			].join(` ${glyph.separator} `);
			const compactHint = [
				`${key("tui.select.up", "up")}/${key("tui.select.down", "down")}`,
				key("tui.select.confirm", "enter"),
				`${key("tui.select.cancel", "escape")} ${cancelAction}`,
			].join(` ${glyph.separator} `);
			const hint = visibleWidth(fullHint) + 2 <= inner ? fullHint : compactHint;
			lines.push(row(` ${theme.fg("dim", hint)}`));
			lines.push(border(glyph.bottomLeft, glyph.bottomRight));
			return lines.slice(0, rows);
		},
		invalidate(): void {},
		handleInput(data: string): void {
			if (keybindings.matches(data, "tui.select.up")) move(-1);
			else if (keybindings.matches(data, "tui.select.down")) move(1);
			else if (keybindings.matches(data, "tui.select.confirm") || data === "\n" || data === "\r") select();
			else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
			else if (filterable && matchesKey(data, Key.backspace)) { filter = [...filter].slice(0, -1).join(""); selectedIndex = 0; }
			else if (filterable) {
				const printable = printableInput(data);
				if (printable !== undefined) { filter += printable; selectedIndex = 0; }
			}
			tui.requestRender();
		},
	};
}

export function selectMenu(
	ctx: ExtensionContext,
	title: string,
	options: string[],
	settings: SelectMenuOptions = {},
	appearance: MenuAppearance = { active: false, ascii: false },
): Promise<string | undefined> {
	if (options.length === 0) return Promise.resolve(undefined);
	if (ctx.mode !== "tui") return ctx.ui.select(title, options);
	const cancelAction = settings.cancelAction ?? (options.includes("Back") ? "back" : "cancel");
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		if (appearance.active) return activeMenu(tui, theme, keybindings, done, title, options, settings, appearance);
		const key = (binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel", fallback: string) => displayKey(keybindings.getKeys?.(binding)[0] ?? fallback);
		const list = new SelectList(options.map((value) => ({ value, label: value })), Math.min(options.length, settings.maxVisible ?? 10), {
			selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
		});
		let selectedIndex = 0;
		const select = () => done(options[selectedIndex]);
		const move = (direction: -1 | 1) => { selectedIndex = (selectedIndex + direction + options.length) % options.length; list.setSelectedIndex(selectedIndex); };
		const hint = [`${key("tui.select.up", "up")}/${key("tui.select.down", "down")} navigate`, `${key("tui.select.confirm", "enter")} select`, `${key("tui.select.cancel", "escape")} ${cancelAction}`].join(" · ");
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", hint), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width) => container.render(width), invalidate: () => container.invalidate(),
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
