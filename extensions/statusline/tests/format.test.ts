import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	formatBranch,
	formatBranchDiff,
	formatCache,
	formatContextBar,
	formatContextText,
	formatCost,
	formatCwd,
	formatEnvironment,
	formatQuota,
	formatTokenDirection,
	formatTokensCompact,
	formatToolActivity,
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

	it("shows hit rate only", () => {
		assert.equal(
			formatCache({ input: 100, output: 0, cacheRead: 400, cacheWrite: 100 }),
			"🎯66.7%",
		);
		assert.equal(
			formatCache({ input: 100, output: 0, cacheRead: 400, cacheWrite: 100 }, true),
			"66.7%",
		);
		assert.equal(
			formatCache({ input: 100, output: 0, cacheRead: 400, cacheWrite: 100 }, false, "plain"),
			"cache 66.7%",
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
	it("renders the bar without a ctx label", () => {
		assert.equal(formatContextBar(40, 10, "remaining"), "[██████░░░░] 60%");
		assert.equal(formatContextBar(40, 10, "used"), "[████░░░░░░] 40%");
		assert.equal(formatContextBar(null, 10, "remaining"), undefined);
	});
});

describe("formatBranchDiff", () => {
	it("hides an empty diff", () => {
		assert.equal(formatBranchDiff({ additions: 0, deletions: 0 }), undefined);
	});
});

describe("formatBranch", () => {
	it("maps default branches by iconMode", () => {
		assert.equal(formatBranch("main", "emoji"), "🏠");
		assert.equal(formatBranch("master", "emoji"), "🏠");
		assert.equal(formatBranch("main", "plain"), "main");
		assert.equal(formatBranch("feature", "emoji"), "feature");
		assert.equal(formatBranch("feature", "plain"), "feature");
	});
});

describe("formatTokenDirection", () => {
	it("switches only the glyph/label", () => {
		assert.equal(formatTokenDirection("in", 12_500, "emoji"), "12.5K");
		assert.equal(formatTokenDirection("out", 3_200, "emoji"), "3.2K");
		assert.equal(formatTokenDirection("in", 12_500, "plain"), "in 12.5K");
		assert.equal(formatTokenDirection("out", 3_200, "plain"), "out 3.2K");
	});
});

describe("formatQuota", () => {
	it("keeps bars identical across icon modes", () => {
		const snapshot = {
			provider: "codex" as const,
			windows: [
				{ id: "primary", label: "5h", usedPercent: 42, windowSeconds: 18_000 },
				{ id: "secondary", label: "7d", usedPercent: 33, windowSeconds: 604_800 },
			],
			capturedAt: Date.now(),
			stale: false,
		};
		assert.equal(formatQuota(snapshot, "emoji", 6), "📊 5h [███░░░] 42% · 7d [██░░░░] 33%");
		assert.equal(formatQuota(snapshot, "plain", 6), "usage 5h [███░░░] 42% · 7d [██░░░░] 33%");
	});
});

describe("formatEnvironment", () => {
	it("formats counts", () => {
		assert.equal(
			formatEnvironment({ contextFiles: 2, skills: 67, tools: 7 }),
			"2 context files · 67 skills · 7 tools",
		);
	});
});

describe("formatToolActivity", () => {
	it("uses emoji or plain labels", () => {
		const activity = {
			Read: { active: 0, success: 6, error: 0 },
			Bash: { active: 0, success: 0, error: 1 },
		};
		assert.equal(formatToolActivity(activity, "emoji"), "✗ Bash x1 · ✓ Read x6");
		assert.equal(formatToolActivity(activity, "plain"), "error Bash x1 · ok Read x6");
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
