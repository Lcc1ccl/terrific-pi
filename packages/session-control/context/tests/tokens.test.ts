import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeContext, charsToTokens, safeContextUsage, topEntries } from "../lib/tokens.ts";
import { redactPreview } from "../lib/redact.ts";

describe("charsToTokens", () => {
	it("uses ~4 ASCII chars per token", () => {
		assert.equal(charsToTokens(0), 0);
		assert.equal(charsToTokens(4), 1);
		assert.equal(charsToTokens(5), 2);
		assert.equal(charsToTokens("abcd"), 1);
	});

	it("counts CJK characters individually", () => {
		assert.equal(charsToTokens("你好世界"), 4);
	});

	it("uses ~3 chars per token for code and JSON", () => {
		assert.equal(charsToTokens('{"a":1}'), 3);
	});
});

describe("safeContextUsage", () => {
	it("reserves model output plus a safety margin from the advertised window", () => {
		assert.deepEqual(safeContextUsage(340_000, 500_000, 128_000), {
			safeInputLimit: 355_616,
			remainingTokens: 15_616,
			percent: 95.6,
		});
		assert.equal(safeContextUsage(null, 500_000, 128_000), undefined);
		assert.equal(safeContextUsage(10, null, 128_000), undefined);
	});

	it("declines a safe percentage when output and reserve consume the full window", () => {
		assert.equal(safeContextUsage(1, 131_072, 131_072), undefined);
		assert.equal(safeContextUsage(1, 131_072, 114_688), undefined);
	});
});

describe("analyzeContext", () => {
	it("counts CJK user content with the text heuristic", () => {
		const breakdown = analyzeContext({ messages: [{ role: "user", content: "你好世界" }] });
		assert.equal(breakdown.categories.user, 4);
	});

	it("classifies message roles", () => {
		const breakdown = analyzeContext({
			systemPrompt: "sys".repeat(100),
			messages: [
				{ role: "user", content: "hello world" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan..." },
						{ type: "text", text: "answer" },
						{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
					],
				},
				{ role: "toolResult", toolName: "bash", content: "a".repeat(400) },
				{ role: "compactionSummary", summary: "summary text" },
			],
			totalTokens: 50_000,
			contextWindow: 100_000,
			percent: 50,
		});

		assert.ok(breakdown.categories.system > 0);
		assert.ok(breakdown.categories.user > 0);
		assert.ok(breakdown.categories.assistantText > 0);
		assert.ok(breakdown.categories.thinking > 0);
		assert.ok(breakdown.categories.toolCalls > 0);
		assert.ok(breakdown.categories.toolResults > 0);
		assert.ok(breakdown.categories.compaction > 0);
		// residual total goes to unclassified
		assert.ok(breakdown.categories.unclassified > 0);
		assert.equal(breakdown.totalTokens, 50_000);
	});

	it("does not inflate image base64 as text", () => {
		const huge = "A".repeat(10_000);
		const breakdown = analyzeContext({
			messages: [
				{
					role: "toolResult",
					toolName: "read",
					content: [
						{ type: "image", mimeType: "image/png", data: huge },
						{ type: "text", text: "ok" },
					],
				},
			],
		});
		assert.equal(breakdown.imageCount, 1);
		assert.ok(breakdown.categories.images > 0);
		// text portion tiny
		assert.ok(breakdown.categories.toolResults < 50);
	});

	it("ranks largest entries", () => {
		const breakdown = analyzeContext({
			messages: [
				{ role: "user", content: "small" },
				{ role: "toolResult", toolName: "bash", content: "x".repeat(4000) },
				{ role: "assistant", content: [{ type: "text", text: "y".repeat(800) }] },
			],
		});
		const top = topEntries(breakdown.entries, 1);
		assert.equal(top.length, 1);
		assert.match(top[0]!.label, /toolResult/);
	});
});

describe("redactPreview", () => {
	it("redacts secrets and truncates", () => {
		const text = "api_key=sk-abcdefghijklmnopqrstuvwxyz012345 and more";
		const out = redactPreview(text, 80);
		assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwxyz012345"));
		assert.match(out, /redacted/i);
	});
});
