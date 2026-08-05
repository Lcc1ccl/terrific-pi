// Width/path helpers derived from OldSuns/pi-open-tui utils.ts at commit c280fcd.
// Changes: retain only appearance header/editor primitives.
import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export { truncateToWidth, visibleWidth };

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*\x07/g, "");
}

export function padRight(text: string, width: number, ellipsis = ""): string {
  const clipped = truncateToWidth(text, Math.max(0, width), ellipsis);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function center(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "...");
  return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2)))}${clipped}`;
}

export function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const rel = relative(resolvedHome, resolvedCwd);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return inside ? (rel === "" ? "~" : `~${sep}${rel}`) : cwd;
}

export function isEditorBorderLine(line: string): boolean {
  const plain = stripAnsi(line);
  return /^─+$/.test(plain) || /^─*\s*[↑↓]\s+\d+\s+more\s*─*$/.test(plain);
}

export function findBottomBorderIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 1; index--) {
    if (isEditorBorderLine(lines[index] ?? "")) return index;
  }
  return Math.max(0, lines.length - 1);
}
