import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import auxiliary, { canConfigureAuxiliary, summarizeText } from "../extensions/auxiliary.ts";

class Events {
	private handlers = new Map<string, Array<(value: unknown) => void>>();
	on(name: string, handler: (value: unknown) => void) {
		const values = this.handlers.get(name) ?? [];
		values.push(handler);
		this.handlers.set(name, values);
		return () => this.handlers.set(name, values.filter((value) => value !== handler));
	}
	emit(name: string, value: unknown) {
		for (const handler of this.handlers.get(name) ?? []) handler(value);
	}
}

describe("auxiliary extension registration", () => {
	test("registers the bounded command, summary tool, and lifecycle hooks", async () => {
		const commands = new Map<string, unknown>();
		const tools = new Map<string, any>();
		const hooks = new Map<string, unknown[]>();
		const entries: Array<{ type: string; data: unknown }> = [];
		const events = new Events();
		const pi = {
			events,
			registerCommand(name: string, value: unknown) { commands.set(name, value); },
			registerTool(value: any) { tools.set(value.name, value); },
			on(name: string, handler: unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
			appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
			setSessionName() {},
			getSessionName() { return undefined; },
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		};
		auxiliary(pi as never);
		assert.deepEqual([...commands.keys()], ["aux"]);
		const auxCommand = commands.get("aux") as {
			description: string;
			handler(args: string, ctx: unknown): Promise<void>;
		};
		assert.match(auxCommand.description, /config/);
		const notifications: string[] = [];
		await auxCommand.handler("config", {
			mode: "print",
			ui: { notify(message: string) { notifications.push(message); } },
		});
		assert.match(notifications.at(-1) ?? "", /TUI mode/);
		assert.equal(tools.has("aux_summarize"), true);
		assert.equal(tools.has("git_finalize"), true);
		assert.equal(tools.has("web_research"), true);
		assert.deepEqual(tools.get("aux_summarize").parameters.properties.source.enum, ["text", "last_tool_result"]);
		assert.deepEqual(tools.get("web_research").parameters.properties.freshness.enum, ["any", "recent", "current"]);
		assert.equal(tools.get("git_finalize").executionMode, "sequential");
		events.emit("vision-handoff:usage", {
			provider: "openai",
			model: "gpt-5.4-mini",
			usage: {
				input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
		});
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.type, "terrific-pi:auxiliary-usage-v1");
		assert.deepEqual((entries[0]!.data as { task: string; usage: { totalTokens: number } }).task, "vision");
		assert.equal((entries[0]!.data as { usage: { totalTokens: number } }).usage.totalTokens, 12);
		for (const event of ["session_start", "session_before_compact", "agent_settled", "session_shutdown"]) {
			assert.equal(hooks.has(event), true, event);
		}
	});
});

describe("auxiliary command interaction", () => {
	test("opens the manager from bare /aux even when /mode removed write", async () => {
		const commands = new Map<string, any>();
		const pi = {
			events: new Events(),
			registerCommand(name: string, value: unknown) { commands.set(name, value); },
			registerTool() {},
			on() {},
			appendEntry() {},
			setSessionName() {},
			getSessionName() { return undefined; },
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
			getActiveTools() { return ["read", "grep"]; },
		};
		auxiliary(pi as never);
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "aux-command-"));
		const titles: string[] = [];
		try {
			await commands.get("aux").handler("", {
				mode: "tui",
				modelRegistry: {
					refresh: async () => {},
					getAvailable: () => [],
				},
				ui: {
					select: async (title: string) => {
						titles.push(title);
						return undefined;
					},
					notify() {},
				},
			});
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
		assert.match(titles[0] ?? "", /Auxiliary Models/);
		assert.equal(canConfigureAuxiliary(["read", "grep", "find", "ls"]), true);
	});

	test("reports effective routes, branch usage, and recent auxiliary failures", async () => {
		const commands = new Map<string, any>();
		const pi = {
			events: new Events(),
			registerCommand(name: string, value: unknown) { commands.set(name, value); },
			registerTool() {},
			on() {},
			appendEntry() {},
			setSessionName() {},
			getSessionName() { return undefined; },
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		};
		auxiliary(pi as never);
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "aux-status-"));
		const notifications: string[] = [];
		try {
			await commands.get("aux").handler("status", {
				mode: "print",
				model: { provider: "openai", id: "main" },
				modelRegistry: { find: () => undefined },
				sessionManager: {
					getBranch: () => [
						{
							type: "custom",
							customType: "terrific-pi:auxiliary-usage-v1",
							data: {
								version: 1, id: "ok", task: "text_summary", executor: "call", provider: "openai", model: "mini",
								thinking: "off", status: "ok", fallbackIndex: 0, startedAt: 1, durationMs: 2,
								usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.25 } },
							},
						},
						{
							type: "custom",
							customType: "terrific-pi:auxiliary-usage-v1",
							data: {
								version: 1, id: "failed", task: "web_research", executor: "delegation", provider: "openai", model: "mini",
								thinking: "low", status: "timeout", fallbackIndex: 0, startedAt: 3, durationMs: 4, errorCode: "timeout",
							},
						},
					],
				},
				ui: { notify(message: string) { notifications.push(message); } },
			});
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
		const message = notifications.at(-1) ?? "";
		assert.match(message, /text_summary: aux/);
		assert.match(message, /git finalize: confirm on .*headless off .*push on/);
		assert.match(message, /usage: 2 calls .*12 tokens .*\$0\.25 .*unknown cost/);
		assert.match(message, /recent auxiliary errors: web_research=timeout/);
	});
});

describe("summarizeText", () => {
	test("runs bounded map-reduce with at most two concurrent chunk calls", async () => {
		let active = 0;
		let maxActive = 0;
		const adapters: string[] = [];
		const result = await summarizeText({
			source: Array.from({ length: 12 }, (_, index) => `paragraph ${index} ${"x".repeat(200)}`).join("\n\n"),
			format: "structured",
			contextWindow: 1_000,
			maxOutputTokens: 100,
			call: async (_messages, adapter) => {
				adapters.push(adapter);
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 2));
				active -= 1;
				return adapter === "text_summary:merge" ? "merged" : `summary ${adapter}`;
			},
		});
		assert.equal(result.text, "merged");
		assert.ok(result.chunks > 1);
		assert.ok(result.chunks <= 8);
		assert.ok(maxActive <= 2);
		assert.equal(adapters.at(-1), "text_summary:merge");
	});

	test("cancels remaining chunks and does not return a partial summary", async () => {
		let siblingAborted = false;
		let siblingSettled = false;
		await assert.rejects(summarizeText({
			source: Array.from({ length: 12 }, (_, index) => `paragraph ${index} ${"x".repeat(200)}`).join("\n\n"),
			format: "brief",
			contextWindow: 1_000,
			maxOutputTokens: 100,
			call: async (_messages, adapter, signal) => {
				if (adapter.endsWith(":1")) {
					await new Promise((resolve) => setTimeout(resolve, 2));
					throw new Error("chunk failed");
				}
				if (adapter.endsWith(":2")) {
					await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => {
						siblingAborted = true;
						setTimeout(() => {
							siblingSettled = true;
							reject(new Error("sibling aborted"));
						}, 5);
					}, { once: true }));
				}
				return "partial";
			},
		}), /chunk failed/);
		assert.equal(siblingAborted, true);
		assert.equal(siblingSettled, true);
	});
});
