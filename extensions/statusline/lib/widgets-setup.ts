import { isKeyRelease, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	buildWidgetEditorItems,
	enabledFromEditorItems,
	moveEditorItem,
	toggleEditorItem,
	widgetEditorAction,
	type WidgetEditorBinding,
	type WidgetEditorItem,
} from "./configure.ts";
import type { StatuslineConfig } from "./types.ts";
import { formatWidgetsPreview } from "./widgets.ts";

export type WidgetsSetupTheme = {
	fg(color: string, text: string): string;
};

export type WidgetsSetupOptions = {
	title: string;
	allWidgets: readonly string[];
	enabled: readonly string[];
	theme: WidgetsSetupTheme;
	previewConfig: StatuslineConfig;
	keybindings: { matches(data: string, binding: WidgetEditorBinding): boolean };
	/** Return true to commit the local editor state after persistence succeeds. */
	onChange: (enabled: string[]) => boolean;
	/** Called when a toggle/move is rejected (e.g. last widget). */
	onReject?: (error: string) => void;
	done: (enabled: string[] | undefined) => void;
	requestRender: () => void;
};

/**
 * Codex-style multi-select + reorder:
 * Space toggle · ↑/↓ select · ←/→ move · Enter done · Esc back
 */
export class WidgetsSetupComponent {
	private items: WidgetEditorItem[];
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private rejectMessage?: string;
	private readonly title: string;
	private readonly theme: WidgetsSetupTheme;
	private readonly previewConfig: StatuslineConfig;
	private readonly keybindings: WidgetsSetupOptions["keybindings"];
	private readonly onChange: (enabled: string[]) => boolean;
	private readonly onReject?: (error: string) => void;
	private readonly done: (enabled: string[] | undefined) => void;
	private readonly requestRender: () => void;

	constructor(options: WidgetsSetupOptions) {
		this.title = options.title;
		this.items = buildWidgetEditorItems(options.enabled, options.allWidgets);
		this.theme = options.theme;
		this.previewConfig = options.previewConfig;
		this.keybindings = options.keybindings;
		this.onChange = options.onChange;
		this.onReject = options.onReject;
		this.done = options.done;
		this.requestRender = options.requestRender;
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;

		const action = widgetEditorAction(data, this.keybindings);
		switch (action) {
			case "cancel":
				this.done(undefined);
				return;
			case "done":
				this.done(enabledFromEditorItems(this.items));
				return;
			case "up":
			case "down": {
				if (this.items.length === 0) return;
				const delta = action === "up" ? -1 : 1;
				this.selected = (this.selected + delta + this.items.length) % this.items.length;
				this.rejectMessage = undefined;
				this.bump();
				return;
			}
			case "left":
				this.move(-1);
				return;
			case "right":
				this.move(1);
				return;
			case "toggle":
				this.toggle();
				return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const enabled = enabledFromEditorItems(this.items);
		const lines: string[] = [
			th.fg("accent", this.title),
			th.fg("dim", "Space toggle · ↑/↓ select · ←/→ move · Enter done · Esc back"),
			"",
		];

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const cursor = i === this.selected ? "›" : " ";
			const box = item.enabled ? "[x]" : "[ ]";
			const raw = `${cursor} ${box} ${item.id}`;
			const label = i === this.selected ? th.fg("accent", raw) : th.fg("text", raw);
			lines.push(truncateToWidth(label, width));
		}

		lines.push("");
		lines.push(th.fg("dim", `enabled: ${enabled.join(" · ") || "(none)"}`));
		lines.push(th.fg("dim", `preview: ${formatWidgetsPreview(enabled, this.previewConfig)}`));
		if (this.rejectMessage) {
			lines.push(th.fg("warning", this.rejectMessage));
		}

		this.cachedLines = lines.map((line) =>
			visibleWidth(line) > width ? truncateToWidth(line, width) : line,
		);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private toggle(): void {
		const result = toggleEditorItem(this.items, this.selected);
		if (!result.ok) {
			this.rejectMessage = result.error;
			this.onReject?.(result.error);
			this.bump();
			return;
		}
		const enabled = enabledFromEditorItems(result.value);
		if (!this.onChange(enabled)) {
			this.rejectMessage = "Change was not saved";
			this.bump();
			return;
		}
		this.items = result.value;
		this.rejectMessage = undefined;
		this.bump();
	}

	private move(delta: -1 | 1): void {
		const result = moveEditorItem(this.items, this.selected, delta);
		if (!result.ok) {
			this.rejectMessage = undefined;
			return;
		}
		const enabled = enabledFromEditorItems(result.value.items);
		if (!this.onChange(enabled)) {
			this.rejectMessage = "Change was not saved";
			this.bump();
			return;
		}
		this.items = result.value.items;
		this.selected = result.value.index;
		this.rejectMessage = undefined;
		this.bump();
	}

	private bump(): void {
		this.invalidate();
		this.requestRender();
	}
}
