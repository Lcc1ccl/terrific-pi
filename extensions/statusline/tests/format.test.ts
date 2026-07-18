import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	barFillTone,
	formatBranch,
	formatBranchDiff,
	formatCache,
	formatContextBar,
	formatContextText,
	formatCost,
	formatCwd,
	formatDurationContent,
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
		assert.equal(formatCost(0).text, "$0.00");
		assert.equal(formatCost(0.421).text, "$0.42");
		assert.equal(formatCost(12.5, true).text, "12.50");
		assert.deepEqual(formatCost(0.42).parts.map((part) => part.tone), ["label", "value"]);
	});
});

describe("formatCache", () => {
	it("returns undefined when empty", () => {
		assert.equal(formatCache({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
	});

	it("shows hit rate only with spaced emoji", () => {
		assert.equal(
			formatCache({ input: 100, output: 0, cacheRead: 400, cacheWrite: 100 })?.text,
			"🎯 66.7%",
		);
		assert.equal(
			formatCache({ input: 100, output: 0, cacheRead: 400, cacheWrite: 100 }, true)?.text,
			"66.7%",
		);
		assert.equal(
			formatCache({ input: 100, output: 0, cacheRead: 400, cacheWrite: 100 }, false, "plain")?.text,
			"cache 66.7%",
		);
	});
});

describe("formatContextText", () => {
	it("formats remaining and used modes", () => {
		assert.equal(formatContextText(37.2, "remaining")?.text, "Context 63% left");
		assert.equal(formatContextText(37.2, "used")?.text, "Context 37% used");
		assert.equal(formatContextText(37.2, "remaining", true)?.text, "63%");
		assert.equal(formatContextText(null, "remaining"), undefined);
	});
});

describe("barFillTone", () => {
	it("uses white/warn/error thresholds on used percent", () => {
		assert.equal(barFillTone(27), "bar");
		assert.equal(barFillTone(59), "bar");
		assert.equal(barFillTone(60), "warn");
		assert.equal(barFillTone(84), "warn");
		assert.equal(barFillTone(85), "error");
	});
});

describe("formatContextBar", () => {
	it("prefixes Context and keeps the bar", () => {
		assert.equal(formatContextBar(40, 10, "remaining")?.text, "Context [██████░░░░] 60%");
		assert.equal(formatContextBar(40, 10, "used")?.text, "Context [████░░░░░░] 40%");
		assert.equal(formatContextBar(null, 10, "remaining"), undefined);
		const tones = formatContextBar(40, 10, "used")?.parts.map((part) => part.tone);
		assert.ok(tones?.includes("label"));
		assert.ok(tones?.includes("bar"));
		assert.ok(tones?.includes("value"));
	});

	it("colors fill by used-percent threshold even in remaining mode", () => {
		const high = formatContextBar(90, 10, "remaining");
		assert.ok(high?.parts.some((part) => part.tone === "error" && part.text.includes("█")));
		const mid = formatContextBar(70, 10, "used");
		assert.ok(mid?.parts.some((part) => part.tone === "warn" && part.text.includes("█")));
	});
});

describe("formatBranchDiff", () => {
	it("hides an empty diff", () => {
		assert.equal(formatBranchDiff({ additions: 0, deletions: 0 }), undefined);
	});

	it("splits signs and numbers", () => {
		const body = formatBranchDiff({ additions: 12, deletions: 3 });
		assert.equal(body?.text, "+12 -3");
		assert.ok(body?.parts.some((part) => part.tone === "success"));
		assert.ok(body?.parts.some((part) => part.tone === "error"));
	});
});

describe("formatBranch", () => {
	it("maps default branches by iconMode", () => {
		assert.equal(formatBranch("main", "emoji").text, "🏠");
		assert.equal(formatBranch("master", "emoji").text, "🏠");
		assert.equal(formatBranch("main", "plain").text, "main");
		assert.equal(formatBranch("feature", "emoji").text, "feature");
		assert.equal(formatBranch("feature", "plain").text, "feature");
	});
});

describe("formatTokenDirection", () => {
	it("uses triangle emojis with a trailing space", () => {
		assert.equal(formatTokenDirection("in", 12_500, "emoji").text, "🔼 12.5K");
		assert.equal(formatTokenDirection("out", 3_200, "emoji").text, "🔽 3.2K");
		assert.equal(formatTokenDirection("in", 12_500, "plain").text, "in 12.5K");
		assert.equal(formatTokenDirection("out", 3_200, "plain").text, "out 3.2K");
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
		assert.equal(formatQuota(snapshot, "emoji", 6)?.text, "📊 5h [███░░░] 42% · 7d [██░░░░] 33%");
		assert.equal(formatQuota(snapshot, "plain", 6)?.text, "usage 5h [███░░░] 42% · 7d [██░░░░] 33%");
	});
});

describe("formatEnvironment", () => {
	it("formats counts as dim text", () => {
		const body = formatEnvironment({ contextFiles: 2, skills: 67, tools: 7 });
		assert.equal(body.text, "2 context files · 67 skills · 7 tools");
		assert.ok(body.parts.every((part) => part.tone === "dim"));
	});
});

describe("formatToolActivity", () => {
	it("uses emoji or plain labels with name/value split", () => {
		const activity = {
			Read: { active: 0, success: 6, error: 0 },
			Bash: { active: 0, success: 0, error: 1 },
		};
		assert.equal(formatToolActivity(activity, "emoji")?.text, "✗ Bash x1 · ✓ Read x6");
		assert.equal(formatToolActivity(activity, "plain")?.text, "error Bash x1 · ok Read x6");
		const parts = formatToolActivity(activity, "emoji")?.parts ?? [];
		assert.ok(parts.some((part) => part.tone === "label" && part.text.includes("Bash")));
		assert.ok(parts.some((part) => part.tone === "value" && part.text === "x1"));
	});
});

describe("formatDurationContent", () => {
	it("prefixes a clock emoji in emoji mode", () => {
		assert.equal(formatDurationContent("12.3s / 1m45s", "emoji").text, "🕒 12.3s / 1m45s");
		assert.equal(formatDurationContent("12.3s / 1m45s", "plain").text, "time 12.3s / 1m45s");
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
