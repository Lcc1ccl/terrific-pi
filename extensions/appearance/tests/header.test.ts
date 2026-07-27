import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createTerrificHeader } from "../lib/header.ts";

function harness(rows: number) {
  const calls: string[] = [];
  const theme = {
    fg(token: string, text: string) { calls.push(token); return `\u001b[3${token === "accent" ? 6 : 7}m${text}\u001b[39m`; },
    bold(text: string) { return `\u001b[1m${text}\u001b[22m`; },
  };
  const tui = { terminal: { rows } };
  return { component: createTerrificHeader(tui as never, theme as never), calls };
}

describe("Terrific header", () => {
  for (const rows of [16, 20, 24]) {
    for (const width of [40, 80, 120, 160]) {
      it(`is neutral and width-safe at ${width} columns and ${rows} rows`, () => {
        const { component, calls } = harness(rows);
        const lines = component.render(width);
        assert.ok(lines.length >= 1 && lines.length <= 3);
        assert.equal(lines.length, rows < 20 ? 1 : 2);
        assert.match(lines.join("\n"), /Terrific/);
        assert.doesNotMatch(lines.join("\n").toLowerCase(), /cwd|model|context|mode|token/);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(calls.every((token) => ["accent", "muted", "dim"].includes(token)));
      });
    }
  }
});
