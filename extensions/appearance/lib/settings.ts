// Settings structure adapted from OldSuns/pi-open-tui settings-command.ts at commit c280fcd.
// Changes: SettingsList, appearance-only fields, and narrow localized labels.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, type Component, type SettingItem } from "@earendil-works/pi-tui";
import type { AppearanceConfig } from "./config.ts";

const COPY = {
  en: {
    labels: { enabled: "General", header: "Header", editor: "Editor", settingsLanguage: "Language" },
    on: "On", off: "Off", language: "English",
  },
  zh: {
    labels: { enabled: "常规", header: "页眉", editor: "编辑器", settingsLanguage: "语言" },
    on: "开启", off: "关闭", language: "简体中文",
  },
} as const;

type SettingId = keyof AppearanceConfig;

class AppearanceSettings implements Component {
  private config: AppearanceConfig;
  private list!: SettingsList;
  private readonly theme: Theme;
  private readonly onChange: (config: AppearanceConfig) => void;
  private readonly onClose: () => void;

  constructor(
    theme: Theme,
    config: AppearanceConfig,
    onChange: (config: AppearanceConfig) => void,
    onClose: () => void,
  ) {
    this.theme = theme;
    this.onChange = onChange;
    this.onClose = onClose;
    this.config = { ...config };
    this.rebuild();
  }

  private rebuild(): void {
    const copy = COPY[this.config.settingsLanguage];
    const value = (enabled: boolean) => enabled ? copy.on : copy.off;
    const items: SettingItem[] = [
      { id: "enabled", label: copy.labels.enabled, currentValue: value(this.config.enabled), values: [copy.on, copy.off] },
      { id: "header", label: copy.labels.header, currentValue: value(this.config.header), values: [copy.on, copy.off] },
      { id: "editor", label: copy.labels.editor, currentValue: value(this.config.editor), values: [copy.on, copy.off] },
      { id: "settingsLanguage", label: copy.labels.settingsLanguage, currentValue: copy.language, values: ["English", "简体中文"] },
    ];
    this.list = new SettingsList(items, items.length, {
      cursor: "→ ",
      label: (text, selected) => selected ? this.theme.fg("accent", text) : text,
      value: (text, selected) => selected ? this.theme.fg("accent", text) : this.theme.fg("muted", text),
      description: (text) => this.theme.fg("muted", text),
      hint: (text) => this.theme.fg("dim", text),
    }, (id, newValue) => {
      const key = id as SettingId;
      this.config = key === "settingsLanguage"
        ? { ...this.config, settingsLanguage: newValue === "简体中文" ? "zh" : "en" }
        : { ...this.config, [key]: newValue === COPY[this.config.settingsLanguage].on };
      this.onChange({ ...this.config });
      this.rebuild();
    }, this.onClose);
  }

  render(width: number): string[] {
    return this.list.render(width).map((line) => truncateToWidth(line, Math.max(0, width), ""));
  }

  handleInput(data: string): void { this.list.handleInput(data); }
  invalidate(): void { this.list.invalidate(); }
}

export function createAppearanceSettings(
  theme: Theme,
  config: AppearanceConfig,
  onChange: (config: AppearanceConfig) => void,
  onClose: () => void,
): Component & { handleInput(data: string): void } {
  return new AppearanceSettings(theme, config, onChange, onClose);
}
