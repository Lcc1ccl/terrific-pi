import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Focusable, visibleWidth } from "@earendil-works/pi-tui";

export type OverlayAction = "close" | "copy" | "enter" | "extra";

export interface TextOverlayOptions {
	title: string;
	lines: string[];
	footer?: string;
	/** Called for c / Enter / extra keys before done. Return true to close. */
	onAction?: (action: OverlayAction) => boolean | void;
	extraKeys?: Array<{ key: string; action: OverlayAction; hint: string }>;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function padVisible(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return text;
	return text + " ".repeat(width - vis);
}

function truncateVisible(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let out = "";
	for (const ch of text) {
		const next = out + ch;
		if (visibleWidth(next) > width - 1) break;
		out = next;
	}
	return `${out}…`;
}

/** Simple scrollable text overlay. Esc/q close, c copy, Enter primary. */
export class TextOverlay implements Focusable {
	focused = false;
	private scroll = 0;
	private readonly title: string;
	private readonly body: string[];
	private readonly footer: string;
	private readonly onAction?: TextOverlayOptions["onAction"];
	private readonly extraKeys: Array<{ key: string; action: OverlayAction; hint: string }>;
	private readonly done: (action: OverlayAction) => void;
	private readonly requestRender: () => void;
	private readonly theme: Theme;

	constructor(
		theme: Theme,
		options: TextOverlayOptions,
		done: (action: OverlayAction) => void,
		requestRender: () => void = () => {},
	) {
		this.theme = theme;
		this.title = options.title;
		this.body = options.lines;
		this.footer = options.footer ?? "[↑/↓] scroll  [c] copy  [Enter] details  [Esc] close";
		this.onAction = options.onAction;
		this.extraKeys = options.extraKeys ?? [];
		this.done = done;
		this.requestRender = requestRender;
	}

	get plainText(): string {
		return this.body.map(stripAnsi).join("\n");
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.finish("close");
			return;
		}
		if (data === "c") {
			this.finish("copy");
			return;
		}
		if (matchesKey(data, "return")) {
			this.finish("enter");
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.scroll = Math.max(0, this.scroll - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.scroll += 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scroll = Math.max(0, this.scroll - 10);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scroll += 10;
			this.requestRender();
			return;
		}
		for (const extra of this.extraKeys) {
			if (data === extra.key) {
				this.finish(extra.action);
				return;
			}
		}
	}

	private finish(action: OverlayAction): void {
		const shouldClose = this.onAction?.(action);
		if (shouldClose === false) return;
		this.done(action);
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (width < 4) return [truncateVisible(this.title, width)];
		const th = this.theme;
		const w = Math.min(width, 100);
		const inner = w - 2;
		const maxBody = Math.max(8, Math.min(24, this.body.length));
		const overflows = this.body.length > maxBody;
		const maxScroll = Math.max(0, this.body.length - maxBody);
		if (this.scroll > maxScroll) this.scroll = maxScroll;

		const row = (content: string) =>
			th.fg("border", "│") + padVisible(truncateVisible(content, inner), inner) + th.fg("border", "│");

		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(inner)}╮`));
		lines.push(row(` ${th.fg("accent", this.title)}`));
		lines.push(row(""));

		const slice = this.body.slice(this.scroll, this.scroll + maxBody);
		for (const line of slice) lines.push(row(` ${line}`));
		for (let i = slice.length; i < maxBody; i++) lines.push(row(""));

		if (overflows) {
			lines.push(row(` ${th.fg("dim", `… ${this.scroll + 1}-${this.scroll + slice.length}/${this.body.length}`)}`));
		}

		lines.push(row(""));
		const footer = overflows ? `Up/Down scroll · ${this.footer}` : this.footer;
		lines.push(row(` ${th.fg("dim", footer)}`));
		lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));
		return lines;
	}
}
