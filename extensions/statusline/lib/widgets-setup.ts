import { isKeyRelease, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	nextWidgetGroup,
	resolveWidgetGroup,
	withWidgetGroupOverride,
} from "./config.ts";
import {
	buildWidgetEditorItems,
	flattenByGroup,
	flattenEnabledByGroup,
	initialWidgetOrder,
	moveInGroups,
	toggleEditorItem,
	widgetEditorAction,
	type WidgetEditorBinding,
	type WidgetEditorItem,
} from "./configure.ts";
import type { StatuslineConfig, WidgetGroup, WidgetId } from "./types.ts";
import { formatWidgetsPreviewLines } from "./widgets.ts";

export type WidgetsSetupTheme = {
	fg(color: string, text: string): string;
};

export type WidgetsSetupOptions = {
	title: string;
	allWidgets: readonly string[];
	enabled: readonly string[];
	widgetGroups?: StatuslineConfig["widgetGroups"];
	theme: WidgetsSetupTheme;
	previewConfig: StatuslineConfig;
	keybindings: { matches(data: string, binding: WidgetEditorBinding): boolean };
	onChange: (
		enabled: string[],
		widgetGroups: StatuslineConfig["widgetGroups"],
	) => boolean;
	onReject?: (error: string) => void;
	done: (enabled: string[] | undefined) => void;
	requestRender: () => void;
};

/**
 * Partition-aware multi-select:
 * Space toggle · g cycle group · ↑/↓ select · ←/→ move any row · Enter done · Esc back
 *
 * Enabled and disabled widgets both reorder; enablement is independent of sort.
 */
export class WidgetsSetupComponent {
	private items: WidgetEditorItem[];
	/** Full catalog order (enabled + disabled). */
	private order: string[];
	private enabledSet: Set<string>;
	private widgetGroups: StatuslineConfig["widgetGroups"];
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private rejectMessage?: string;
	private readonly title: string;
	private readonly allWidgets: readonly string[];
	private readonly theme: WidgetsSetupTheme;
	private readonly previewConfig: StatuslineConfig;
	private readonly keybindings: WidgetsSetupOptions["keybindings"];
	private readonly onChange: WidgetsSetupOptions["onChange"];
	private readonly onReject?: (error: string) => void;
	private readonly done: (enabled: string[] | undefined) => void;
	private readonly requestRender: () => void;

	constructor(options: WidgetsSetupOptions) {
		this.title = options.title;
		this.allWidgets = options.allWidgets;
		this.order = initialWidgetOrder(options.enabled, options.allWidgets);
		this.enabledSet = new Set(dedupeEnabled(options.enabled, options.allWidgets));
		this.widgetGroups = options.widgetGroups ? { ...options.widgetGroups } : undefined;
		this.items = this.rebuildItems();
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
				this.done(this.enabledList());
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
			th.fg("dim", "Space toggle · g cycle group · ↑/↓ select · ←/→ move any · Enter done · Esc back"),
			th.fg("dim", "Section = stacked line; mock preview uses sample data"),
			"",
		];

		let lastGroup: WidgetGroup | undefined;
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const group = resolveWidgetGroup(item.id, this.widgetGroups);
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

		const enabled = this.enabledList();
		const visualEnabled = flattenEnabledByGroup(enabled, this.widgetGroups);
		const previewLines = formatWidgetsPreviewLines(visualEnabled, {
			...this.previewConfig,
			widgets: visualEnabled,
			...(this.widgetGroups ? { widgetGroups: { ...this.widgetGroups } } : {}),
		});

		lines.push("");
		lines.push(th.fg("dim", "mock:"));
		for (const line of previewLines) {
			lines.push(th.fg("dim", truncateToWidth(`  ${line}`, width)));
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

	private enabledList(): string[] {
		return flattenByGroup(this.order, this.widgetGroups).filter((id) => this.enabledSet.has(id));
	}

	private rebuildItems(): WidgetEditorItem[] {
		return buildWidgetEditorItems(
			[...this.enabledSet],
			this.allWidgets,
			this.widgetGroups,
			this.order,
		);
	}

	private commit(
		nextOrder: string[],
		nextEnabled: ReadonlySet<string>,
		nextGroups: StatuslineConfig["widgetGroups"],
	): boolean {
		const enabled = flattenByGroup(nextOrder, nextGroups).filter((id) => nextEnabled.has(id));
		if (!this.onChange(enabled, nextGroups)) {
			this.rejectMessage = "Change was not saved";
			this.bump();
			return false;
		}
		this.order = nextOrder;
		this.enabledSet = new Set(nextEnabled);
		this.widgetGroups = nextGroups;
		this.items = this.rebuildItems();
		this.rejectMessage = undefined;
		this.bump();
		return true;
	}

	private focusId(id: string): void {
		const next = this.items.findIndex((item) => item.id === id);
		if (next >= 0) this.selected = next;
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

		const nextEnabled = new Set(this.enabledSet);
		if (current.enabled) nextEnabled.delete(current.id);
		else nextEnabled.add(current.id);

		if (!this.commit(this.order, nextEnabled, this.widgetGroups)) return;
		this.focusId(current.id);
	}

	private cycleGroup(): void {
		const current = this.items[this.selected];
		if (!current) return;
		const id = current.id as WidgetId;
		const group = resolveWidgetGroup(id, this.widgetGroups);
		const nextGroups = withWidgetGroupOverride(this.widgetGroups, id, nextWidgetGroup(group));
		if (!this.commit(this.order, this.enabledSet, nextGroups)) return;
		this.focusId(id);
	}

	private move(delta: -1 | 1): void {
		const current = this.items[this.selected];
		if (!current) return;

		const moved = moveInGroups(this.order, this.widgetGroups, current.id, delta);
		if (!moved) {
			this.rejectMessage = undefined;
			return;
		}
		if (!this.commit(moved.order, this.enabledSet, moved.widgetGroups)) return;
		this.focusId(current.id);
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
