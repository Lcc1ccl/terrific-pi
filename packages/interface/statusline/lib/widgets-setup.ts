import { isKeyRelease, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	buildWidgetEditorItems,
	cycleWidgetLine,
	enabledLines,
	flattenWidgetLines,
	initialEditorLines,
	moveWidgetInLines,
	toggleEditorItem,
	widgetEditorAction,
	type WidgetEditorBinding,
	type WidgetEditorItem,
} from "./configure.ts";
import { cloneWidgetLines } from "./config.ts";
import type { StatuslineConfig, WidgetId, WidgetLines } from "./types.ts";
import { WIDGET_LINE_IDS } from "./types.ts";
import { formatWidgetsPreviewLines } from "./widgets.ts";

export type WidgetsSetupTheme = {
	fg(color: string, text: string): string;
};

export type WidgetsSetupOptions = {
	title: string;
	allWidgets: readonly WidgetId[];
	lines: WidgetLines;
	theme: WidgetsSetupTheme;
	previewConfig: StatuslineConfig;
	keybindings: {
		matches(data: string, binding: WidgetEditorBinding): boolean;
		getKeys?(binding: WidgetEditorBinding): string[];
	};
	onChange: (lines: WidgetLines) => boolean;
	onReject?: (error: string) => void;
	done: (lines: WidgetLines | undefined) => void;
	requestRender: () => void;
};

/** Five-line multi-select: Space toggle, g cycle line, arrows select/move. */
export class WidgetsSetupComponent {
	private items: WidgetEditorItem[];
	private editorLines: WidgetLines;
	private enabledSet: Set<WidgetId>;
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private rejectMessage?: string;
	private readonly title: string;
	private readonly theme: WidgetsSetupTheme;
	private readonly previewConfig: StatuslineConfig;
	private readonly keybindings: WidgetsSetupOptions["keybindings"];
	private readonly onChange: WidgetsSetupOptions["onChange"];
	private readonly onReject?: (error: string) => void;
	private readonly done: WidgetsSetupOptions["done"];
	private readonly requestRender: () => void;

	constructor(options: WidgetsSetupOptions) {
		this.title = options.title;
		this.editorLines = initialEditorLines(options.lines, options.allWidgets);
		this.enabledSet = new Set(flattenWidgetLines(options.lines));
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
			this.cycleLine();
			return;
		}
		const action = widgetEditorAction(data, this.keybindings);
		switch (action) {
			case "cancel": this.done(undefined); return;
			case "done": this.done(this.currentLines()); return;
			case "up":
			case "down": {
				if (this.items.length === 0) return;
				const delta = action === "up" ? -1 : 1;
				this.selected = (this.selected + delta + this.items.length) % this.items.length;
				this.rejectMessage = undefined;
				this.bump();
				return;
			}
			case "left": this.move(-1); return;
			case "right": this.move(1); return;
			case "toggle": this.toggle(); return;
		}
	}

	private key(binding: WidgetEditorBinding, fallback: string): string {
		const value = this.keybindings.getKeys?.(binding)[0] ?? fallback;
		return (({ up: "Up", down: "Down", left: "Left", right: "Right", enter: "Enter", escape: "Esc" } as Record<string, string>)[value]
			?? value.replace(/\b[a-z]/g, (char) => char.toUpperCase()));
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [
			th.fg("accent", this.title),
			th.fg("dim", [
				"Space toggle",
				"g line",
				`${this.key("tui.select.up", "up")}/${this.key("tui.select.down", "down")} select`,
				`${this.key("tui.editor.cursorLeft", "left")}/${this.key("tui.editor.cursorRight", "right")} move`,
				`${this.key("tui.select.confirm", "enter")} done`,
				`${this.key("tui.select.cancel", "escape")} back`,
			].join(" · ")),
			th.fg("dim", "LINE0 = editor bottom-right; LINE1-4 = footer rows"),
			"",
		];

		for (const [lineIndex, line] of WIDGET_LINE_IDS.entries()) {
			if (lineIndex > 0) lines.push("");
			lines.push(th.fg("dim", `— ${line.toUpperCase()} —`));
			for (let index = 0; index < this.items.length; index++) {
				const item = this.items[index]!;
				if (item.line !== line) continue;
				const cursor = index === this.selected ? "›" : " ";
				const box = item.enabled ? "[x]" : "[ ]";
				const raw = `${cursor} ${box} ${item.id}`;
				lines.push(truncateToWidth(index === this.selected ? th.fg("accent", raw) : th.fg("text", raw), width));
			}
		}

		const previewLines = formatWidgetsPreviewLines(this.currentLines(), {
			...this.previewConfig,
			lines: this.currentLines(),
		});
		lines.push("", th.fg("dim", "mock:"));
		for (const line of previewLines) lines.push(th.fg("dim", truncateToWidth(`  ${line}`, width)));
		if (this.rejectMessage) lines.push("", th.fg("warning", this.rejectMessage));

		this.cachedLines = lines.map((line) => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private currentLines(): WidgetLines {
		return enabledLines(this.editorLines, this.enabledSet);
	}

	private rebuildItems(): WidgetEditorItem[] {
		return buildWidgetEditorItems(this.editorLines, this.enabledSet);
	}

	private commit(nextEditorLines: WidgetLines, nextEnabled: ReadonlySet<WidgetId>): boolean {
		const nextLines = enabledLines(nextEditorLines, nextEnabled);
		if (!this.onChange(cloneWidgetLines(nextLines))) {
			this.rejectMessage = "Change was not saved";
			this.bump();
			return false;
		}
		this.editorLines = nextEditorLines;
		this.enabledSet = new Set(nextEnabled);
		this.items = this.rebuildItems();
		this.rejectMessage = undefined;
		this.bump();
		return true;
	}

	private focusId(id: WidgetId): void {
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
		if (this.commit(this.editorLines, nextEnabled)) this.focusId(current.id);
	}

	private cycleLine(): void {
		const current = this.items[this.selected];
		if (!current) return;
		const moved = cycleWidgetLine(this.editorLines, current.id);
		if (moved && this.commit(moved, this.enabledSet)) this.focusId(current.id);
	}

	private move(delta: -1 | 1): void {
		const current = this.items[this.selected];
		if (!current) return;
		const moved = moveWidgetInLines(this.editorLines, current.id, delta);
		if (!moved) {
			this.rejectMessage = undefined;
			return;
		}
		if (this.commit(moved, this.enabledSet)) this.focusId(current.id);
	}

	private bump(): void {
		this.invalidate();
		this.requestRender();
	}
}
