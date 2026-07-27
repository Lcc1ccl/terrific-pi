import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

function fit(line: string, width: number): string {
  const budget = Math.max(0, Math.floor(width));
  const result = truncateToWidth(line, budget, "");
  return visibleWidth(result) <= budget ? result : truncateToWidth(result, budget, "");
}

export function createTerrificHeader(tui: TUI, theme: Theme): Component {
  return {
    render(width: number): string[] {
      const title = fit(theme.bold(theme.fg("accent", "Terrific")), width);
      if (tui.terminal.rows < 20) return [title];
      const rule = fit(theme.fg("dim", "─".repeat(Math.max(0, width))), width);
      return [title, rule];
    },
    invalidate() {},
  };
}
