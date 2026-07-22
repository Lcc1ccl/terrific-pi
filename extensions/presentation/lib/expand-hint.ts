import { keyText } from "@earendil-works/pi-coding-agent";

interface ExpandHintTheme {
	fg(color: "muted" | "dim", text: string): string;
}

export function expandHint(theme: ExpandHintTheme): string {
	const key = keyText("app.tools.expand") || "Ctrl+O";
	return `${theme.fg("dim", key)}${theme.fg("muted", " to expand")}`;
}
