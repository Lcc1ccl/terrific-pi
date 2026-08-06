// Derived from OldSuns/pi-open-tui editor.ts at commit c280fcd.
// Changes: static package ownership, no cleanup setter, and narrow width fallback.
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { findBottomBorderIndex, isEditorBorderLine, stripAnsi } from "./utils.ts";

function fillLine(content: string, width: number): string {
  const clipped = truncateToWidth(content, Math.max(0, width), "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function roundedBorder(width: number, kind: "top" | "bottom", paint: (text: string) => string, source?: string): string {
  const corners = kind === "top" ? (["╭", "╮"] as const) : (["╰", "╯"] as const);
  if (width < 2) return paint(truncateToWidth(corners.join(""), width, ""));
  const scroll = source ? stripAnsi(source).match(/([↑↓]\s+\d+\s+more)/)?.[1] : undefined;
  const label = scroll ? `─── ${scroll} ` : "";
  return paint(`${corners[0]}${label}${"─".repeat(Math.max(0, width - 2 - visibleWidth(label)))}${corners[1]}`);
}

export class AppearanceEditor extends CustomEditor {
  constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, editorTheme, keybindings, { paddingX: 0 });
  }

  override setPaddingX(_padding: number): void {
    super.setPaddingX(0);
  }

  override render(width: number): string[] {
    if (width < 4) return super.render(width).map((line) => truncateToWidth(line, width, ""));
    const innerWidth = width - 4;
    const base = super.render(innerWidth);
    const bottom = findBottomBorderIndex(base);
    const lines = [roundedBorder(width, "top", this.borderColor, base[0])];
    for (let index = 1; index < bottom; index++) {
      const line = base[index] ?? "";
      lines.push(`${this.borderColor("│")} ${fillLine(isEditorBorderLine(line) ? "" : line, innerWidth)} ${this.borderColor("│")}`);
    }
    lines.push(roundedBorder(width, "bottom", this.borderColor, base[bottom]));
    for (let index = bottom + 1; index < base.length; index++) lines.push(base[index] ?? "");
    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}
