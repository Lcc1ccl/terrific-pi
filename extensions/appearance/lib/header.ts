// Derived from OldSuns/pi-open-tui header.ts at commit c280fcd.
// Changes: final static logo only, deterministic tips, no screen clearing or animation.
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { center, formatCwd, padRight, truncateToWidth, visibleWidth } from "./utils.ts";

const FINAL_LOGO = [
  "            ",
  "            ",
  "█████████   ",
  "███   ███   ",
  "██████   ███",
  "███      ███",
  "            ",
];

function border(left: string, label: string, right: string, width: number, paint: (text: string) => string): string {
  if (width <= 1) return truncateToWidth(left, width, "");
  const middle = label ? `── ${label} ` : "";
  return `${paint(left)}${paint(middle)}${paint("─".repeat(Math.max(0, width - 2 - visibleWidth(middle))))}${paint(right)}`;
}

function boxed(content: string, width: number, paint: (text: string) => string): string {
  if (width <= 2) return truncateToWidth(content, width, "");
  return `${paint("│")}${padRight(content, width - 2)}${paint("│")}`;
}

function commandTips(pi: ExtensionAPI): string[] {
  const names = ["appearance", ...pi.getCommands().map((command) => command.name)]
    .map((name) => name.trim()).filter(Boolean);
  return [...new Set(names)].slice(0, 4).map((name) => `/${name}`);
}

export class AppearanceHeader implements Component {
  private readonly tips: string[];
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext, _tui: TUI) {
    this.pi = pi;
    this.ctx = ctx;
    this.tips = commandTips(pi);
  }

  render(width: number): string[] {
    const theme = this.ctx.ui.theme;
    const paint = (text: string) => theme.fg("accent", text);
    const muted = (text: string) => theme.fg("muted", text);
    if (width < 24) return [truncateToWidth(paint(`Pi v${VERSION}`), width, "")];

    const model = this.ctx.model?.id
      ? `${this.ctx.model.provider ? `${this.ctx.model.provider}/` : ""}${this.ctx.model.id}`
      : "no-model";
    const thinking = this.pi.getThinkingLevel();
    const facts = [muted(`${model} · ${thinking === "off" ? "thinking off" : `${thinking} effort`}`), muted(formatCwd(this.ctx.cwd))];
    const useTips = width >= 52;
    const inner = width - 2;
    const rightWidth = useTips ? Math.min(24, Math.max(16, Math.floor(inner * 0.3))) : 0;
    const leftWidth = useTips ? inner - rightWidth - 3 : inner;
    const left = [...FINAL_LOGO.map((line) => center(paint(line), leftWidth)), center(theme.bold("Let's build something great"), leftWidth), ...facts.map((line) => center(line, leftWidth))];
    const right = [paint(theme.bold("Commands")), ...this.tips.map(muted)];
    const lines = [border("╭", `${paint("Pi")} v${VERSION}`, "╮", width, paint)];
    for (let index = 0; index < left.length; index++) {
      const content = useTips
        ? `${padRight(left[index] ?? "", leftWidth)} ${paint("│")} ${padRight(right[index - 2] ?? "", rightWidth)}`
        : padRight(left[index] ?? "", leftWidth);
      lines.push(boxed(content, width, paint));
    }
    lines.push(border("╰", "", "╯", width, paint));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}
}
