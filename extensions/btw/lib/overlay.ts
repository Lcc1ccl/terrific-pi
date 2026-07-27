import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Focusable, visibleWidth } from "@earendil-works/pi-tui";

export type OverlayAction = "close" | "copy" | "enter" | "extra";

export interface TextOverlayOptions {
	title: string;
	lines: string[];
	footer?: string;
	/** Called for c / Enter / extra keys before done. Return true to close. */
	onAction?: (action: OverlayAction) => boolean | void;
	extraKeys?: Array<{ key: string; action: OverlayAction; hint: string }>;
}

export interface TextOverlayStyle {
	active: boolean;
	ascii: boolean;
	getTerminalRows?: () => number;
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

function sanitizeDisplay(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
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
	private readonly style: TextOverlayStyle;

	constructor(
		theme: Theme,
		options: TextOverlayOptions,
		done: (action: OverlayAction) => void,
		requestRender: () => void = () => {},
		style: TextOverlayStyle = { active: false, ascii: false },
	) {
		this.theme = theme;
		this.title = options.title;
		this.body = options.lines;
		this.footer = options.footer ?? "[↑/↓] scroll  [c] copy  [Enter] details  [Esc] close";
		this.onAction = options.onAction;
		this.extraKeys = options.extraKeys ?? [];
		this.done = done;
		this.requestRender = requestRender;
		this.style = style;
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

	private renderActive(width: number): string[] {
		if (width <= 0) return [];
		const title = sanitizeDisplay(this.title);
		if (width < 4) return [truncateToWidth(title, width, "")];
		const th = this.theme;
		const w = Math.min(width, 120);
		const inner = w - 2;
		const rows = Math.max(1, this.style.getTerminalRows?.() ?? 24);
		const glyph = this.style.ascii
			? { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", separator: "..." }
			: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│", separator: "…" };
		const border = (left: string, right: string, label = "") => {
			const clean = truncateToWidth(label, Math.max(0, inner - 2), "…");
			const prefix = clean ? `${glyph.horizontal} ${clean} ` : "";
			return th.fg("border", left + prefix + glyph.horizontal.repeat(Math.max(0, inner - visibleWidth(prefix))) + right);
		};
		const row = (content: string) => th.fg("border", glyph.vertical)
			+ truncateToWidth(content, inner, "…", true)
			+ th.fg("border", glyph.vertical);

		let maxBody = Math.max(1, Math.min(24, this.body.length, rows - 3));
		let overflows = this.body.length > maxBody;
		if (overflows) maxBody = Math.max(1, Math.min(maxBody, rows - 4));
		const maxScroll = Math.max(0, this.body.length - maxBody);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		const slice = this.body.slice(this.scroll, this.scroll + maxBody);
		overflows = this.body.length > slice.length;

		const lines = [border(glyph.topLeft, glyph.topRight, title)];
		for (const line of slice) lines.push(row(` ${sanitizeDisplay(line)}`));
		if (overflows) {
			lines.push(row(` ${th.fg("dim", `${glyph.separator} ${this.scroll + 1}-${this.scroll + slice.length}/${this.body.length}`)}`));
		}
		const footer = overflows ? `Up/Down scroll · ${sanitizeDisplay(this.footer)}` : sanitizeDisplay(this.footer);
		lines.push(row(` ${th.fg("dim", footer)}`));
		lines.push(border(glyph.bottomLeft, glyph.bottomRight));
		return lines.slice(0, rows);
	}

	render(width: number): string[] {
		if (this.style.active) return this.renderActive(width);
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
