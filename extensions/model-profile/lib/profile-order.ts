import { isKeyRelease, truncateToWidth } from "@earendil-works/pi-tui";

import type { ModelProfile } from "./types.ts";

type ProfileOrderBinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.confirm"
	| "tui.select.cancel"
	| "tui.editor.cursorLeft"
	| "tui.editor.cursorRight";

export interface ProfileOrderOptions {
	profiles: readonly ModelProfile[];
	theme: { fg(color: string, text: string): string };
	keybindings: {
		matches(data: string, binding: ProfileOrderBinding): boolean;
		getKeys?(binding: ProfileOrderBinding): string[];
	};
	done(profiles: ModelProfile[] | undefined): void;
	requestRender(): void;
}

export class ProfileOrderComponent {
	private profiles: ModelProfile[];
	private selected = 0;
	private readonly theme: ProfileOrderOptions["theme"];
	private readonly keybindings: ProfileOrderOptions["keybindings"];
	private readonly done: ProfileOrderOptions["done"];
	private readonly requestRender: ProfileOrderOptions["requestRender"];

	constructor(options: ProfileOrderOptions) {
		this.profiles = [...options.profiles];
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.done = options.done;
		this.requestRender = options.requestRender;
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done([...this.profiles]);
			return;
		}
		if (this.profiles.length === 0) return;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selected = (this.selected - 1 + this.profiles.length) % this.profiles.length;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.selected = (this.selected + 1) % this.profiles.length;
		} else {
			const delta = this.keybindings.matches(data, "tui.editor.cursorLeft")
				? -1
				: this.keybindings.matches(data, "tui.editor.cursorRight") ? 1 : 0;
			const target = this.selected + delta;
			if (delta === 0 || target < 0 || target >= this.profiles.length) return;
			[this.profiles[this.selected], this.profiles[target]] = [this.profiles[target]!, this.profiles[this.selected]!];
			this.selected = target;
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines = [
			th.fg("accent", "Profile hotkey order"),
			th.fg("dim", `${this.key("tui.select.up", "up")}/${this.key("tui.select.down", "down")} select · ${this.key("tui.editor.cursorLeft", "left")}/${this.key("tui.editor.cursorRight", "right")} move · ${this.key("tui.select.confirm", "enter")} save · ${this.key("tui.select.cancel", "escape")} back`),
			"",
			...this.profiles.map((profile, index) => {
				const hotkey = index < 9 ? `Alt+${index + 1}` : "none";
				const row = `${index === this.selected ? "›" : " "} ${hotkey.padEnd(5)}  ${profile.alias}  ${profile.provider}/${profile.model} · ${profile.thinking}`;
				return index === this.selected ? th.fg("accent", row) : th.fg("text", row);
			}),
		];
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}

	private key(binding: ProfileOrderBinding, fallback: string): string {
		const value = this.keybindings.getKeys?.(binding)[0] ?? fallback;
		return ({ up: "Up", down: "Down", left: "Left", right: "Right", enter: "Enter", escape: "Esc" } as Record<string, string>)[value]
			?? value.replace(/\b[a-z]/g, (char) => char.toUpperCase());
	}
}
