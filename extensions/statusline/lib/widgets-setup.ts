import { isKeyRelease, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	nextWidgetGroup,
	resolveWidgetGroup,
	withWidgetGroupOverride,
} from "./config.ts";
import {
	buildWidgetEditorItems,
	toggleEditorItem,
	widgetEditorAction,
	type WidgetEditorBinding,
	type WidgetEditorItem,
} from "./configure.ts";
import type { StatuslineConfig, WidgetId } from "./types.ts";

export type WidgetsSetupTheme = {
	fg(color: string, text: string): string;
};

export type WidgetsSetupOptions = {
	title: string;
	allWidgets: readonly string[];
	enabled: readonly string[];
	widgetGroups?: StatuslineConfig["widgetGroups"];
	theme: WidgetsSetupTheme;
	keybindings: { matches(data: string, binding: WidgetEditorBinding): boolean };
	/** Return true to commit the local editor state after persistence succeeds. */
	onChange: (
		enabled: string[],
		widgetGroups: StatuslineConfig["widgetGroups"],
	) => boolean;
	/** Called when a toggle/move is rejected (e.g. last widget). */
	onReject?: (error: string) => void;
	done: (enabled: string[] | undefined) => void;
	requestRender: () => void;
};

/**
 * Free-order multi-select:
 * Space toggle · g cycle group · ↑/↓ select · ←/→ reorder enabled · Enter done · Esc back
 *
 * Live footer already reflects saved changes — no in-editor preview strip.
 */
export class WidgetsSetupComponent {
	private items: WidgetEditorItem[];
	/** Config order of enabled widgets (source of truth). */
	private enabledOrder: string[];
	/** Stacked-line group overrides (source of truth). */
	private widgetGroups: StatuslineConfig["widgetGroups"];
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private rejectMessage?: string;
	private readonly title: string;
	private readonly allWidgets: readonly string[];
	private readonly theme: WidgetsSetupTheme;
	private readonly keybindings: WidgetsSetupOptions["keybindings"];
	private readonly onChange: WidgetsSetupOptions["onChange"];
	private readonly onReject?: (error: string) => void;
	private readonly done: (enabled: string[] | undefined) => void;
	private readonly requestRender: () => void;

	constructor(options: WidgetsSetupOptions) {
		this.title = options.title;
		this.allWidgets = options.allWidgets;
		this.enabledOrder = dedupeEnabled(options.enabled, options.allWidgets);
		this.widgetGroups = options.widgetGroups ? { ...options.widgetGroups } : undefined;
		this.items = buildWidgetEditorItems(this.enabledOrder, options.allWidgets);
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.onChange = options.onChange;
		this.onReject = options.onReject;
		this.done = options.done;
		this.requestRender = options.requestRender;
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;

		if (data === "g" || data === "G") {
			this.cycleGroup();
			return;
		}

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
			th.fg("dim", "Space toggle · g cycle group · ↑/↓ select · ←/→ reorder · Enter done · Esc back"),
			th.fg("dim", "Group affects stacked layout lines; live footer updates on each save"),
			"",
		];

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const group = resolveWidgetGroup(item.id, this.widgetGroups);
			const cursor = i === this.selected ? "›" : " ";
			const box = item.enabled ? "[x]" : "[ ]";
			const raw = `${cursor} ${box} ${item.id}  · ${group}`;
			const label = i === this.selected ? th.fg("accent", raw) : th.fg("text", raw);
			lines.push(truncateToWidth(label, width));
		}

		if (this.rejectMessage) {
			lines.push("");
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

	private commit(nextEnabled: string[], nextGroups: StatuslineConfig["widgetGroups"]): boolean {
		if (!this.onChange(nextEnabled, nextGroups)) {
			this.rejectMessage = "Change was not saved";
			this.bump();
			return false;
		}
		this.enabledOrder = nextEnabled;
		this.widgetGroups = nextGroups;
		this.items = buildWidgetEditorItems(this.enabledOrder, this.allWidgets);
		this.rejectMessage = undefined;
		this.bump();
		return true;
	}

	private toggle(): void {
		const current = this.items[this.selected];
		if (!current) return;

		const projected = toggleEditorItem(this.items, this.selected);
		if (!projected.ok) {
			this.rejectMessage = projected.error;
			this.onReject?.(projected.error);
			this.bump();
			return;
		}

		const nextEnabled = current.enabled
			? this.enabledOrder.filter((id) => id !== current.id)
			: [...this.enabledOrder, current.id];

		if (!this.commit(nextEnabled, this.widgetGroups)) return;
		const next = this.items.findIndex((item) => item.id === current.id);
		if (next >= 0) this.selected = next;
	}

	private cycleGroup(): void {
		const current = this.items[this.selected];
		if (!current) return;
		const id = current.id as WidgetId;
		const group = resolveWidgetGroup(id, this.widgetGroups);
		const nextGroup = nextWidgetGroup(group);
		const nextGroups = withWidgetGroupOverride(this.widgetGroups, id, nextGroup);
		if (!this.commit(this.enabledOrder, nextGroups)) return;
		const next = this.items.findIndex((item) => item.id === id);
		if (next >= 0) this.selected = next;
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
		if (!this.commit(swapped, this.widgetGroups)) return;
		const next = this.items.findIndex((item) => item.id === current.id);
		if (next >= 0) this.selected = next;
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
