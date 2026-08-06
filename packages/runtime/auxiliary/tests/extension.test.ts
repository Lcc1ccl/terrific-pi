import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
	listenerCount(name: string) {
		return this.handlers.get(name)?.length ?? 0;
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
			getArgumentCompletions(prefix: string): Array<{ value: string }>;
			handler(args: string, ctx: unknown): Promise<void>;
		};
		assert.match(auxCommand.description, /config/);
		assert.deepEqual(auxCommand.getArgumentCompletions("").map((item) => item.value), ["config", "status", "summarize"]);
		assert.deepEqual(auxCommand.getArgumentCompletions("st").map((item) => item.value), ["status"]);
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
		assert.equal(events.listenerCount("vision-handoff:usage"), 0);
		events.emit("vision-handoff:usage", {
			provider: "openai",
			model: "gpt-5.4-mini",
			usage: {
				input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
		});
		assert.equal(entries.length, 0);
		for (const event of ["session_start", "session_tree", "before_agent_start", "tool_call", "session_before_compact", "agent_settled", "session_shutdown"]) {
			assert.equal(hooks.has(event), true, event);
		}
		const finalizeGate = hooks.get("tool_call")?.[0] as ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
		assert.deepEqual(await finalizeGate?.({ toolName: "git_finalize", toolCallId: "git-1" }, {
			sessionManager: {
				getBranch: () => [{
					message: { role: "assistant", content: [{ type: "toolCall", id: "write-1" }, { type: "toolCall", id: "git-1" }] },
				}],
			},
		}), { block: true, reason: "git_finalize must be the only tool call in its assistant response" });
	});

	test("falls back when the primary research output violates the result contract", async () => {
		const tools = new Map<string, any>();
		const entries: Array<{ type: string; data: any }> = [];
		const events = new Events();
		const pi = {
			events,
			registerCommand() {},
			registerTool(value: any) { tools.set(value.name, value); },
			on() {},
			appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
			setSessionName() {},
			getSessionName() { return undefined; },
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		};
		auxiliary(pi as never);
		const previous = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "aux-research-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			auxiliary: { tasks: { web_research: { model: "test/primary", fallbackModels: ["test/fallback"] } } },
		}));
		const attempted: string[] = [];
		events.on("prompt-template:subagent:request", (value) => {
			const request = value as { requestId: string; model: string };
			attempted.push(request.model);
			events.emit("prompt-template:subagent:started", { version: 1, requestId: request.requestId });
			const output = request.model === "test/primary"
				? "invalid research output"
				: "ok\nhttps://one.test\nhttps://two.test\nhttps://three.test";
			events.emit("prompt-template:subagent:response", {
				version: 1, requestId: request.requestId, status: "completed", output,
			});
		});
		try {
			const result = await tools.get("web_research").execute("research-1", {
				question: "question", freshness: "any", sourcePreference: "mixed",
			}, undefined, undefined, {
				cwd: "/workspace",
				modelRegistry: {
					find: (provider: string, id: string) => ({ provider, id, input: ["text"], reasoning: false }),
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "ephemeral" }),
				},
				ui: { setStatus() {} },
			});
			assert.match(result.content[0].text, /three\.test/);
			assert.deepEqual(attempted, ["test/primary", "test/fallback"]);
			assert.deepEqual(entries.map((entry) => entry.data.status), ["error", "ok"]);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});

	test("does not block agent_settled while generating a title", () => {
		const hooks = new Map<string, any[]>();
		const pi = {
			events: new Events(),
			registerCommand() {},
			registerTool() {},
			on(name: string, handler: unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
			appendEntry() {},
			setSessionName() {},
			getSessionName() { return undefined; },
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		};
		auxiliary(pi as never);
		const result = hooks.get("agent_settled")?.[0]({}, {
			modelRegistry: {
				find: () => undefined,
				getRegisteredProviderIds: () => [],
				getRegisteredProviderConfig: () => undefined,
			},
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "user", content: [{ type: "text", text: "fix title hook" }] } },
					{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
				],
			},
			ui: { setStatus() {}, notify() {} },
		});
		assert.equal(result, undefined);
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
			getCommands() { return []; },
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
					select: async () => undefined,
					custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
						const component = factory(
							{ requestRender() {} },
							{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
							{
								matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\x1b",
								getKeys: () => [],
							},
							resolve,
						);
						titles.push(component.render(200).join("\n"));
						component.handleInput("\x1b");
					}),
					notify() {},
				},
			});
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
		assert.match(titles[0] ?? "", /Auxiliary Models/);
		assert.doesNotMatch(titles[0] ?? "", /Vision: external|vision-handoff/);
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
						{
							type: "custom",
							customType: "terrific-pi:auxiliary-usage-v1",
							data: {
								version: 1, id: "internal-failed", task: "pilot_router", executor: "call", provider: "openai", model: "mini",
								thinking: "off", status: "error", fallbackIndex: 0, startedAt: 5, durationMs: 6, errorCode: "provider_error",
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
		assert.match(message, /usage: 3 calls .*12 tokens .*\$0\.25 .*unknown cost/);
		assert.match(message, /recent auxiliary errors: web_research=timeout/);
		assert.doesNotMatch(message, /pilot_router/);
		await commands.get("aux").handler("tasks", {
			mode: "print",
			ui: { notify(value: string) { notifications.push(value); } },
		});
		assert.match(notifications.at(-1) ?? "", /Usage: \/aux/);
		assert.doesNotMatch(notifications.at(-1) ?? "", /auxiliary: enabled/);
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
