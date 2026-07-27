import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

export function fitBorderLabel(
  label: string,
  width: number,
  paddingX: number,
  color: (text: string) => string,
): string {
  const budget = Math.max(0, Math.floor(width));
  if (budget === 0) return "";
  const padding = Math.min(Math.max(0, Math.floor(paddingX)), budget);
  const labelBudget = Math.max(0, budget - padding - 2);
  const fittedLabel = truncateToWidth(label, labelBudget, "");
  const prefix = fittedLabel ? `${"─".repeat(padding)} ${fittedLabel} ` : "─".repeat(padding);
  const raw = `${prefix}${"─".repeat(Math.max(0, budget - visibleWidth(prefix)))}`;
  const fitted = truncateToWidth(color(raw), budget, "");
  const missing = budget - visibleWidth(fitted);
  return missing > 0 ? `${fitted}${color("─".repeat(missing))}` : fitted;
}

export class TerrificEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;
    const prompt = process.env.TERM === "dumb" ? ">" : "❯";
    lines[0] = fitBorderLabel(prompt, width, this.getPaddingX(), this.borderColor);
    if (lines.length > 1) lines[lines.length - 1] = fitBorderLabel("", width, this.getPaddingX(), this.borderColor);
    return lines;
  }
}
