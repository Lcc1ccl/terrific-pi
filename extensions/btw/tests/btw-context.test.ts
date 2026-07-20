import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { truncateMessagesForBtw } from "../lib/btw-context.ts";
import { parseBtwCommandArgs } from "../lib/command.ts";
import { charsToTokens, type ClassifiableMessage } from "../lib/tokens.ts";

describe("parseBtwCommandArgs", () => {
	it("accepts an explicit no-context one-shot question", () => {
		assert.deepEqual(parseBtwCommandArgs("context=none explain this"), {
			contextMode: "none",
			question: "explain this",
		});
	});

	it("keeps current context as the default", () => {
		assert.deepEqual(parseBtwCommandArgs("what changed?"), {
			contextMode: "current",
			question: "what changed?",
		});
	});
});

describe("truncateMessagesForBtw", () => {
	it("strips images", () => {
		const messages: ClassifiableMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "see this" },
					{ type: "image", data: "AAAA".repeat(100), mimeType: "image/png" },
				],
			},
		];
		const out = truncateMessagesForBtw(messages, 10_000);
		assert.equal(out.length, 1);
		const content = out[0]!.content;
		assert.ok(Array.isArray(content));
		assert.ok(content.some((p) => p.type === "text" && String(p.text).includes("image omitted")));
		assert.ok(!content.some((p) => p.type === "image"));
	});

	it("keeps tool call and tool result together", () => {
		const messages: ClassifiableMessage[] = [
			{ role: "user", content: "start " + "u".repeat(200) },
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
			},
			{ role: "toolResult", toolName: "bash", content: "file.txt" },
			{ role: "user", content: "later " + "z".repeat(200) },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];

		// Tight budget forces truncation but must not orphan toolResult without call
		const out = truncateMessagesForBtw(messages, 80);
		const roles = out.map((m) => m.role);
		const toolIdx = roles.indexOf("toolResult");
		if (toolIdx >= 0) {
			assert.equal(roles[toolIdx - 1], "assistant");
		}
	});

	it("prefers recent messages under budget", () => {
		const messages: ClassifiableMessage[] = [];
		for (let i = 0; i < 20; i++) {
			messages.push({ role: "user", content: `turn-${i} ` + "x".repeat(200) });
			messages.push({ role: "assistant", content: [{ type: "text", text: `a-${i} ` + "y".repeat(200) }] });
		}
		const out = truncateMessagesForBtw(messages, 300);
		assert.ok(out.length < messages.length);
		const text = JSON.stringify(out);
		assert.match(text, /turn-19|a-19/);
	});

	it("enforces the budget when a turn is larger than the limit", () => {
		const messages: ClassifiableMessage[] = [
			{ role: "user", content: `first ${"a".repeat(4000)}` },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: `latest ${"b".repeat(4000)}` },
		];
		const maxTokens = 10;
		const out = truncateMessagesForBtw(messages, maxTokens);
		const text = out
			.flatMap((message) =>
				typeof message.content === "string"
					? [message.content]
					: (message.content ?? []).map((part) => part.text ?? ""),
			)
			.join("\n");

		assert.ok(charsToTokens(text.length) <= maxTokens);
		assert.match(text, /latest/);
		assert.doesNotMatch(text, /first/);
	});

	it("excludes excludeFromContext messages", () => {
		const out = truncateMessagesForBtw(
			[
				{ role: "user", content: "keep" },
				{ role: "user", content: "skip", excludeFromContext: true },
			],
			10_000,
		);
		assert.equal(out.length, 1);
		const content = out[0]!.content;
		const text = typeof content === "string" ? content : (content ?? []).map((p) => p.text ?? "").join("");
		assert.equal(text, "keep");
	});
});
