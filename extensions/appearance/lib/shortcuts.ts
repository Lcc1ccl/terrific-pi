import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

export const SHORTCUT_WIDGET_KEY = "terrific-pi:appearance-shortcuts";

const ACTIONS = [
  ["tui.input.submit", "submit"],
  ["tui.input.newLine", "newline"],
  ["app.tools.expand", "tools"],
  ["app.thinking.toggle", "thinking"],
  ["app.model.select", "model"],
] as const;

export class ShortcutsWidget implements Component {
  public readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;

  constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
  }

  render(width: number): string[] {
    if (width < 72 || this.tui.terminal.rows < 20) return [];
    const hints = ACTIONS.flatMap(([action, label]) => {
      const keys = this.keybindings.getKeys(action);
      return keys.length === 0 ? [] : [`${this.theme.fg("accent", keys.join("/"))} ${label}`];
    });
    if (hints.length === 0) return [];
    const line = this.theme.fg("muted", hints.join("  ·  "));
    const fitted = truncateToWidth(line, width, "");
    return visibleWidth(fitted) <= width ? [fitted] : [truncateToWidth(fitted, width, "")];
  }

  invalidate() {}
}

export function createShortcutsWidget(tui: TUI, theme: Theme, keybindings: KeybindingsManager): ShortcutsWidget {
  return new ShortcutsWidget(tui, theme, keybindings);
}
