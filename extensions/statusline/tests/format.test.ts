import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	formatCache,
	formatContextBar,
	formatContextText,
	formatCost,
	formatCwd,
	formatTokensCompact,
} from "../lib/format.ts";

describe("formatTokensCompact", () => {
	it("formats small and large values", () => {
		assert.equal(formatTokensCompact(0), "0");
		assert.equal(formatTokensCompact(999), "999");
		assert.equal(formatTokensCompact(1_500), "1.5K");
		assert.equal(formatTokensCompact(12_300), "12.3K");
		assert.equal(formatTokensCompact(1_200_000), "1.2M");
	});
});

describe("formatCost", () => {
	it("formats usd with two decimals by default", () => {
		assert.equal(formatCost(0), "$0.00");
		assert.equal(formatCost(0.421), "$0.42");
		assert.equal(formatCost(12.5, true), "12.50");
	});
});

describe("formatCache", () => {
	it("returns undefined when empty", () => {
		assert.equal(formatCache({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
	});

	it("shows plain r/w and hit rate", () => {
		assert.equal(
			formatCache({ input: 100, output: 0, cacheRead: 400, cacheWrite: 100 }),
			"↓400 ↑100 🎯66.7%",
		);
		assert.equal(
			formatCache({ input: 100, output: 0, cacheRead: 400, cacheWrite: 100 }, true),
			"↓400 ↑100 66.7%",
		);
	});
});

describe("formatContextText", () => {
	it("formats remaining and used modes", () => {
		assert.equal(formatContextText(37.2, "remaining"), "Context 63% left");
		assert.equal(formatContextText(37.2, "used"), "Context 37% used");
		assert.equal(formatContextText(37.2, "remaining", true), "63%");
		assert.equal(formatContextText(null, "remaining"), undefined);
	});
});

describe("formatContextBar", () => {
	it("renders compact bar with remaining percent", () => {
		assert.equal(formatContextBar(40, 10, "remaining"), "ctx [██████░░░░] 60%");
		assert.equal(formatContextBar(40, 10, "used", true), "[████░░░░░░] 40%");
		assert.equal(formatContextBar(null, 10, "remaining"), undefined);
	});
});

describe("formatCwd", () => {
	it("abbreviates home directory", () => {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		assert.ok(home);
		assert.equal(formatCwd(home), "~");
		assert.equal(formatCwd(`${home}/projects/pi`), `~/projects/pi`);
	});
});
