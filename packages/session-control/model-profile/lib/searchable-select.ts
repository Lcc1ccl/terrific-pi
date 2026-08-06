/**
 * Type-to-filter select, matching pi /model interaction:
 * Input search + fuzzy filter + up/down/enter/esc.
 */
import { Container, Input, Text, fuzzyFilter } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";

export interface SearchableSelectItem {
	value: string;
	label: string;
	/** Extra text used only for fuzzy search (e.g. model name). */
	searchText?: string;
}

function displayKey(key: string): string {
	return (
		{ up: "Up", down: "Down", enter: "Enter", escape: "Esc" }[key] ??
		key.replace(/\b[a-z]/g, (char) => char.toUpperCase())
	);
}

function itemSearchText(item: SearchableSelectItem): string {
	return item.searchText ?? `${item.label} ${item.value}`;
}

/**
 * Interactive searchable list. Returns selected value, or undefined on cancel.
 * Empty query shows all items in original order (like /model).
 */
export function selectSearchableOption(
	ctx: ExtensionContext,
	title: string,
	items: readonly SearchableSelectItem[],
	settings: {
		cancelAction?: "back" | "cancel";
		initialSelectedValue?: string;
		maxVisible?: number;
	} = {},
): Promise<string | undefined> {
	if (items.length === 0) return Promise.resolve(undefined);

	const cancelAction = settings.cancelAction ?? "cancel";
	const maxVisible = settings.maxVisible ?? 10;

	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const keys = (
			id: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
			fallback: string,
		) => displayKey(keybindings.getKeys?.(id)[0] ?? fallback);

		const hint = [
			"type to filter",
			`${keys("tui.select.up", "up")}/${keys("tui.select.down", "down")} navigate`,
			`${keys("tui.select.confirm", "enter")} select`,
			`${keys("tui.select.cancel", "escape")} ${cancelAction}`,
		].join(" · ");

		const input = new Input();
		input.focused = true;

		let filtered = [...items];
		let selectedIndex = Math.max(
			0,
			settings.initialSelectedValue
				? items.findIndex((item) => item.value === settings.initialSelectedValue)
				: 0,
		);
		if (selectedIndex < 0) selectedIndex = 0;

		const applyFilter = () => {
			const query = input.getValue().trim();
			filtered = query ? fuzzyFilter([...items], query, itemSearchText) : [...items];
			selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
		};

		const renderList = (): string[] => {
			if (filtered.length === 0) {
				return [theme.fg("warning", "  No matching models")];
			}
			const start = Math.max(
				0,
				Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible),
			);
			const end = Math.min(start + maxVisible, filtered.length);
			const lines: string[] = [];
			for (let i = start; i < end; i++) {
				const item = filtered[i]!;
				const selected = i === selectedIndex;
				const prefix = selected ? "→ " : "  ";
				const text = selected
					? theme.fg("accent", `${prefix}${item.label}`)
					: `${prefix}${item.label}`;
				lines.push(text);
			}
			if (start > 0 || end < filtered.length) {
				lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${filtered.length})`));
			}
			return lines;
		};

		return {
			render: (width) => {
				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
				container.addChild(input);
				for (const line of renderList()) {
					container.addChild(new Text(line, 0, 0));
				}
				container.addChild(new Text(theme.fg("dim", hint), 1, 0));
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				return container.render(width);
			},
			invalidate: () => {
				input.invalidate?.();
			},
			handleInput: (data) => {
				if (keybindings.matches?.(data, "tui.select.cancel")) {
					done(undefined);
				} else if (keybindings.matches?.(data, "tui.select.confirm") || data === "\n" || data === "\r") {
					const item = filtered[selectedIndex];
					if (item) done(item.value);
				} else if (keybindings.matches?.(data, "tui.select.up")) {
					if (filtered.length > 0) {
						selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
					}
				} else if (keybindings.matches?.(data, "tui.select.down")) {
					if (filtered.length > 0) {
						selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
					}
				} else {
					input.handleInput(data);
					applyFilter();
				}
				tui.requestRender();
			},
		};
	});
}
