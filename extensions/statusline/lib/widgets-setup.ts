import { isKeyRelease, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	buildWidgetEditorItems,
	toggleEditorItem,
	widgetEditorAction,
	widgetGroupOf,
	type WidgetEditorBinding,
	type WidgetEditorItem,
} from "./configure.ts";
import type { StatuslineConfig, WidgetGroup } from "./types.ts";
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
 * Space toggle · ↑/↓ select · ←/→ move enabled · Enter done · Esc back
 *
 * `enabledOrder` is the source of truth for config widget order.
 * Grouped `items` are a display/edit projection and must not rewrite that order on toggle.
 */
export class WidgetsSetupComponent {
	private items: WidgetEditorItem[];
	/** Config order of enabled widgets (not group display order). */
	private enabledOrder: string[];
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private rejectMessage?: string;
	private readonly title: string;
	private readonly allWidgets: readonly string[];
	private readonly theme: WidgetsSetupTheme;
	private readonly previewConfig: StatuslineConfig;
	private readonly keybindings: WidgetsSetupOptions["keybindings"];
	private readonly onChange: (enabled: string[]) => boolean;
	private readonly onReject?: (error: string) => void;
	private readonly done: (enabled: string[] | undefined) => void;
	private readonly requestRender: () => void;

	constructor(options: WidgetsSetupOptions) {
		this.title = options.title;
		this.allWidgets = options.allWidgets;
		this.enabledOrder = dedupeEnabled(options.enabled, options.allWidgets);
		this.items = buildWidgetEditorItems(this.enabledOrder, options.allWidgets);
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
				this.done([...this.enabledOrder]);
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
		const lines: string[] = [
			th.fg("accent", this.title),
			th.fg("dim", "Space toggle · ↑/↓ select · ←/→ reorder enabled · Enter done · Esc back"),
			th.fg("dim", "Groups: project · usage · environment · activity"),
			"",
		];

		let lastGroup: WidgetGroup | undefined;
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const group = widgetGroupOf(item.id);
			if (group !== lastGroup) {
				if (lastGroup !== undefined) lines.push("");
				lines.push(th.fg("dim", `— ${group} —`));
				lastGroup = group;
			}
			const cursor = i === this.selected ? "›" : " ";
			const box = item.enabled ? "[x]" : "[ ]";
			const raw = `${cursor} ${box} ${item.id}`;
			const label = i === this.selected ? th.fg("accent", raw) : th.fg("text", raw);
			lines.push(truncateToWidth(label, width));
		}

		lines.push("");
		lines.push(th.fg("dim", `enabled: ${this.enabledOrder.join(" · ") || "(none)"}`));
		lines.push(th.fg("dim", `preview: ${formatWidgetsPreview(this.enabledOrder, this.previewConfig)}`));
		lines.push(th.fg("dim", "Ⅰ after tokens/cost = auxiliary usage (dim, not a separate widget)"));
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
		const current = this.items[this.selected];
		if (!current) return;

		// Validate via shared toggle helper (last-widget guard).
		const projected = toggleEditorItem(this.items, this.selected);
		if (!projected.ok) {
			this.rejectMessage = projected.error;
			this.onReject?.(projected.error);
			this.bump();
			return;
		}

		let nextEnabled: string[];
		if (current.enabled) {
			nextEnabled = this.enabledOrder.filter((id) => id !== current.id);
		} else {
			nextEnabled = [...this.enabledOrder, current.id];
		}

		if (!this.onChange(nextEnabled)) {
			this.rejectMessage = "Change was not saved";
			this.bump();
			return;
		}

		this.enabledOrder = nextEnabled;
		this.items = buildWidgetEditorItems(this.enabledOrder, this.allWidgets);
		const next = this.items.findIndex((item) => item.id === current.id);
		if (next >= 0) this.selected = next;
		this.rejectMessage = undefined;
		this.bump();
	}

	private move(delta: -1 | 1): void {
		const current = this.items[this.selected];
		if (!current?.enabled) {
			this.rejectMessage = "Select an enabled widget to reorder";
			this.bump();
			return;
		}

		const index = this.enabledOrder.indexOf(current.id);
		if (index < 0) return;
		const swapped = swapEnabled(this.enabledOrder, index, delta);
		if (!swapped) {
			this.rejectMessage = undefined;
			return;
		}
		if (!this.onChange(swapped)) {
			this.rejectMessage = "Change was not saved";
			this.bump();
			return;
		}
		this.enabledOrder = swapped;
		this.items = buildWidgetEditorItems(this.enabledOrder, this.allWidgets);
		const next = this.items.findIndex((item) => item.id === current.id);
		if (next >= 0) this.selected = next;
		this.rejectMessage = undefined;
		this.bump();
	}

	private bump(): void {
		this.invalidate();
		this.requestRender();
	}
}

function dedupeEnabled(enabled: readonly string[], allWidgets: readonly string[]): string[] {
	const allSet = new Set(allWidgets);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of enabled) {
		if (!allSet.has(id) || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

function swapEnabled(enabled: readonly string[], index: number, delta: -1 | 1): string[] | undefined {
	const target = index + delta;
	if (index < 0 || index >= enabled.length || target < 0 || target >= enabled.length) {
		return undefined;
	}
	const next = [...enabled];
	const current = next[index]!;
	next[index] = next[target]!;
	next[target] = current;
	return next;
}
