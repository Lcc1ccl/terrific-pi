import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

import btwExtension from "../extensions/btw.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

it("labels the global BTW target separately from the effective project value", async () => {
	const root = mkdtempSync(join(tmpdir(), "btw-config-scope-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({ btw: { maxContextTokens: 5_000 } }));
	writeFileSync(join(projectDir, ".pi", "terrific.json"), JSON.stringify({ btw: { maxContextTokens: 1_234 } }));

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		let command: any;
		btwExtension({
			registerCommand(_name: string, value: unknown) { command = value; },
			on() {},
		} as never);
		assert.match(command.description, /context=current/);
		assert.deepEqual(command.getArgumentCompletions("").map((item: { value: string }) => item.value), [
			"status", "config", "context=current", "context=none",
		]);
		let rendered = "";
		await command.handler("config", {
			cwd: projectDir,
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => true,
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
					rendered = component.render(200).join("\n");
					component.handleInput("\x1b");
				}),
				notify() {},
				confirm: async () => false,
			},
		});

		assert.match(rendered, /write: global/);
		assert.match(rendered, /effective: 1234/);
		assert.match(rendered, /Write target context budget: 5000/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

it("treats session shutdown as one cancellation without starting fallback authentication", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "btw-shutdown-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
		auxiliary: {
			enabled: true,
			tasks: {
				btw: {
					model: "test/one",
					fallbackModels: ["test/two"],
					timeoutMs: 600_000,
				},
			},
		},
	}), "utf8");

	let command: any;
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
	const emitted: Array<{ name: string; value: any }> = [];
	const notifications: string[] = [];
	const authCalls: string[] = [];
	const authStarted = deferred<void>();
	try {
		initTheme("dark", false);
		btwExtension({
			events: { emit(name: string, value: unknown) { emitted.push({ name, value }); } },
			registerCommand(_name: string, value: unknown) { command = value; },
			on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
		} as never);
		const model = (id: string) => ({
			provider: "test",
			id,
			api: "openai-responses",
			input: ["text"],
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 2_000,
		});
		const ctx: any = {
			cwd: "/workspace",
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => false,
			model: model("current"),
			modelRegistry: {
				find(provider: string, id: string) { return provider === "test" ? model(id) : undefined; },
				getApiKeyAndHeaders(candidate: { id: string }) {
					authCalls.push(candidate.id);
					authStarted.resolve();
					return new Promise(() => {});
				},
			},
			sessionManager: { getEntries: () => [], getLeafId: () => null },
			ui: {
				notify(message: string) { notifications.push(message); },
				setStatus() {},
				custom(factory: any) {
					let component: { dispose?: () => void } | undefined;
					return new Promise((resolve) => {
						component = factory(
							{ requestRender() {} },
							{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
							{},
							(value: unknown) => {
								component?.dispose?.();
								resolve(value);
							},
						);
					});
				},
			},
		};

		const request = command.handler("question", ctx);
		await authStarted.promise;
		await handlers.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);
		await request;

		assert.deepEqual(authCalls, ["one"]);
		const usage = emitted
			.filter((event) => event.name === "terrific-pi:auxiliary-usage:ingest-v1")
			.map((event) => event.value);
		assert.equal(usage.length, 1);
		assert.equal(usage[0]?.status, "aborted");
		assert.equal(usage[0]?.errorCode, "aborted");
		assert.equal(notifications.some((message) => /request failed/i.test(message)), false);
	} finally {
		await handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, {});
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

it("emits a settled usage scope from the real /btw command path", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "btw-scope-"));
	let command: any;
	const emitted: Array<{ name: string; value: any }> = [];
	try {
		btwExtension({
			events: { emit(name: string, value: unknown) { emitted.push({ name, value }); } },
			registerCommand(_name: string, value: unknown) { command = value; },
			on() {},
		} as never);
		await command.handler("question", {
			cwd: "/workspace",
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => false,
			modelRegistry: { find: () => undefined },
			ui: { notify() {} },
		});
		const settled = emitted.filter((event) => event.name === "terrific-pi:auxiliary-usage:scope-settled-v1");
		assert.equal(settled.length, 1);
		assert.equal(settled[0]?.value.version, 1);
		assert.match(settled[0]?.value.scopeId ?? "", /^[0-9a-f-]{36}$/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
