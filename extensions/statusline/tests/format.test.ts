import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	appendAuxTokenExtras,
	formatBranch,
	formatBranchDiff,
	formatCache,
	formatContextBar,
	formatContextText,
	formatCost,
	formatCwd,
	formatDurationContent,
	formatSessionName,
	SESSION_NAME_MAX_CHARS,
	formatEnvironment,
	formatFastBadge,
	formatModeContent,
	formatModelContent,
	formatQuota,
	formatTokenDirection,
	formatTokensCompact,
	formatToolActivity,
	modeTone,
	usageValueTone,
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

	it("appends dim auxiliary cost with Ⅰ", () => {
		assert.equal(formatCost(0.42, false, 0.03).text, "$0.42Ⅰ $0.03");
		const tones = formatCost(0.42, false, 0.03).parts.map((part) => part.tone);
		assert.ok(tones.includes("dim"));
		assert.equal(formatCost(0.42, false, 0.03, true).text, "$0.42Ⅰ $0.03?");
		assert.equal(formatCost(0.42, false, 0, true).text, "$0.42Ⅰ ?");
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
		assert.equal(formatContextText(70.1, "used")?.parts.at(-1)?.tone, "warn");
		assert.equal(formatContextText(null, "remaining"), undefined);
	});
});

describe("usageValueTone", () => {
	it("matches pi's native context thresholds", () => {
		assert.equal(usageValueTone(70), "value");
		assert.equal(usageValueTone(70.1), "warn");
		assert.equal(usageValueTone(90), "warn");
		assert.equal(usageValueTone(90.1), "error");
	});
});

describe("formatContextBar", () => {
	it("prefixes Context and keeps the bar", () => {
		assert.equal(formatContextBar(40, 10, "remaining")?.text, "Context [██████░░░░] 60%");
		assert.equal(formatContextBar(40, 10, "used")?.text, "Context [████░░░░░░] 40%");
		assert.equal(formatContextBar(40, 10, "used", true)?.text, "[████░░░░░░] 40%");
		assert.equal(formatContextBar(null, 10, "remaining"), undefined);
		const tones = formatContextBar(40, 10, "used")?.parts.map((part) => part.tone);
		assert.ok(tones?.includes("label"));
		assert.ok(tones?.includes("bar"));
		assert.ok(tones?.includes("value"));
	});

	it("keeps the bar neutral and colors only the percentage", () => {
		const warning = formatContextBar(75, 10, "remaining");
		assert.ok(warning?.parts.some((part) => part.tone === "bar" && part.text.includes("█")));
		assert.equal(warning?.parts.at(-1)?.tone, "warn");
		const error = formatContextBar(95, 10, "used");
		assert.ok(error?.parts.some((part) => part.tone === "bar" && part.text.includes("█")));
		assert.equal(error?.parts.at(-1)?.tone, "error");
	});
});

describe("formatModelContent", () => {
	it("always shows reasoning level with pi's native theme token", () => {
		assert.deepEqual(formatModelContent("gpt-5", "off", true), {
			text: "gpt-5 off",
			parts: [
				{ text: "gpt-5", tone: "value" },
				{ text: " off", tone: "thinkingOff" },
			],
		});
		assert.equal(formatModelContent("gpt-5", "max", true).parts.at(-1)?.tone, "thinkingMax");
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

	it("appends dim auxiliary tokens with Ⅰ", () => {
		assert.equal(formatTokenDirection("in", 167_000, "plain", 3_700).text, "in 167KⅠ 3.7K");
		const parts = formatTokenDirection("in", 167_000, "plain", 3_700).parts;
		assert.ok(parts.some((part) => part.tone === "dim" && part.text.includes("3.7K")));
	});
});

describe("appendAuxTokenExtras", () => {
	it("surfaces unknown even when some aux in/out is already known", () => {
		const parts = [{ text: "in 1.5KⅠ 3.7K", tone: "value" as const }];
		appendAuxTokenExtras(parts, { input: 3700, output: 0, unsplit: 0, unknown: true });
		assert.equal(parts.map((part) => part.text).join(""), "in 1.5KⅠ 3.7KⅠ ?");
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
	it("keeps per-tool success and aggregates errors", () => {
		const activity = {
			Read: { active: 0, success: 6, error: 1 },
			Bash: { active: 0, success: 3, error: 2 },
			Write: { active: 0, success: 1, error: 1 },
		};
		assert.equal(formatToolActivity(activity, "emoji")?.text, "✗ total x4 · ✓ Bash x3 · ✓ Read x6 · ✓ Write x1");
		assert.equal(formatToolActivity(activity, "plain")?.text, "error total x4 · ok Bash x3 · ok Read x6 · ok Write x1");
		const parts = formatToolActivity(activity, "emoji")?.parts ?? [];
		assert.ok(parts.some((part) => part.tone === "label" && part.text.includes("Bash")));
		assert.ok(parts.some((part) => part.tone === "label" && part.text.includes("total")));
		assert.ok(parts.some((part) => part.tone === "success" && part.text.includes("✓")));
		assert.ok(parts.some((part) => part.tone === "error" && part.text.includes("✗")));
		assert.ok(parts.some((part) => part.tone === "value" && part.text === "x4"));
		assert.equal(parts.filter((part) => part.tone === "label").length, 4);
	});

	it("reserves accent for active tools", () => {
		const parts = formatToolActivity({ Bash: { active: 1, success: 0, error: 0 } }, "emoji")?.parts ?? [];
		assert.ok(parts.some((part) => part.tone === "active" && part.text.includes("…")));
	});

	it("compacts core and aux tool buckets", () => {
		const activity = {
			bash: { active: 0, success: 54, error: 5 },
			edit: { active: 0, success: 20, error: 2 },
			read: { active: 1, success: 29, error: 3 },
			write: { active: 0, success: 2, error: 0 },
			web_research: { active: 0, success: 3, error: 1 },
			subagent: { active: 0, success: 5, error: 4 },
		};
		assert.equal(
			formatToolActivity(activity, "emoji", "compact")?.text,
			"✗ total x15 · … core_tools x1 · ✓ core_tools x105 · ✓ aux_tools x3",
		);
	});
});

describe("formatFastBadge", () => {
	it("uses the warning tone for the emoji badge", () => {
		assert.equal(formatFastBadge("", "emoji")?.parts[0]?.tone, "warn");
		assert.equal(formatFastBadge("", "plain")?.parts[0]?.tone, "label");
	});
});

describe("modeTone", () => {
	it("maps permission modes to quiet theme tones", () => {
		assert.equal(modeTone("ASK"), "dim");
		assert.equal(modeTone("plan"), "muted");
		assert.equal(modeTone("Edit"), "value");
		assert.equal(modeTone("AUTO"), "thinkingLow");
		assert.equal(modeTone("other"), "muted");
		assert.equal(formatModeContent("EDIT").parts[0]?.tone, "value");
	});
});

describe("formatDurationContent", () => {
	it("prefixes a clock emoji in emoji mode", () => {
		assert.equal(formatDurationContent("12s / 1m45s", "emoji").text, "🕒 12s / 1m45s");
		assert.equal(formatDurationContent("12s / 1m45s", "plain").text, "time 12s / 1m45s");
		assert.equal(formatDurationContent("12s/1m45s", "emoji", true).text, "12s/1m45s");
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

describe("formatSessionName", () => {
	it("keeps short names and truncates long ones", () => {
		assert.equal(formatSessionName("demo"), "demo");
		const long = "A".repeat(SESSION_NAME_MAX_CHARS + 8);
		const truncated = formatSessionName(long);
		assert.equal(Array.from(truncated).length, SESSION_NAME_MAX_CHARS);
		assert.ok(truncated.endsWith("…"));
	});

	it("counts unicode by code point", () => {
		assert.equal(formatSessionName("标题生成测试用的很长会话名再加一点", 8), "标题生成测试用…");
	});
});
