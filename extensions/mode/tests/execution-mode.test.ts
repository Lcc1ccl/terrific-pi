import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import modeExtension from "../extensions/mode.ts";

it("restores startup tools before reload", async () => {
	let tools = ["read", "bash", "edit", "write"];
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	modeExtension({
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getActiveTools: () => [...tools],
		setActiveTools: (next: string[]) => { tools = [...next]; },
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as never);
	const ctx = {
		cwd: "/tmp/pi-mode-test",
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => false,
		ui: { notify() {}, setStatus() {}, select: async () => undefined },
		sessionManager: { getBranch: () => entries },
	};
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	await commands.get("mode")!.handler("ask", ctx);
	assert.deepEqual(tools, ["read", "grep", "find", "ls"]);
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
	assert.deepEqual(tools, ["read", "bash", "edit", "write"]);
});

it("shows the global write target separately from a trusted project's effective mode", async () => {
	const root = mkdtempSync(join(tmpdir(), "mode-config-scope-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
		appearance: { profile: "off" },
		mode: { default: "edit", persistPerSession: true },
	}));
	writeFileSync(join(projectDir, ".pi", "terrific.json"), JSON.stringify({ mode: { default: "ask" } }));

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousTerm = process.env.TERM;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.TERM = "xterm-256color";
	try {
		let tools = ["read", "bash", "edit", "write"];
		let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
		modeExtension({
			registerCommand: (_name: string, value: any) => { command = value; },
			on() {},
			getActiveTools: () => [...tools],
			setActiveTools: (next: string[]) => { tools = [...next]; },
			appendEntry() {},
		} as never);

		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			appearance: { profile: "terrific-native-v1" },
			mode: { default: "edit", persistPerSession: true },
		}));
		let rendered = "";
		await command!.handler("config", {
			cwd: projectDir,
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => true,
			ui: {
				setStatus() {},
				notify() {},
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
				confirm: async () => false,
			},
		});

		assert.match(rendered, /^╭─ Mode configuration/);
		assert.match(rendered, /write: global/);
		assert.match(rendered, /effective: ask/);
		assert.match(rendered, /Global default mode: edit/);
		assert.match(rendered, /Global persist per session: on/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	}
});

it("keeps mode transitions and tool arrays identical across visual profiles", async () => {
	async function run(profile: "off" | "terrific-native-v1") {
		const agentDir = mkdtempSync(join(tmpdir(), `mode-visual-${profile}-`));
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			appearance: { profile },
			mode: { default: "edit", persistPerSession: false },
		}));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			let tools = ["read", "grep", "find", "ls", "bash", "edit", "write"];
			const transitions: string[][] = [];
			const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
			let command: any;
			modeExtension({
				registerCommand(_name: string, value: unknown) { command = value; },
				on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
				getActiveTools: () => [...tools],
				setActiveTools(next: string[]) { tools = [...next]; transitions.push([...next]); },
				appendEntry() {},
			} as never);
			const ctx = {
				cwd: "/workspace", hasUI: true, mode: "tui", isProjectTrusted: () => false,
				sessionManager: { getBranch: () => [] },
				ui: {
					notify() {}, setStatus() {}, select: async () => undefined,
					custom: async (factory: any) => new Promise<string | undefined>((resolve) => {
						const component = factory(
							{ terminal: { rows: 24 }, requestRender() {} },
							{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
							{
								matches: (data: string, binding: string) => ({ "\x1b[B": "tui.select.down", "\r": "tui.select.confirm" } as Record<string, string>)[data] === binding,
								getKeys: () => [],
							},
							resolve,
						);
						component.handleInput("\x1b[B");
						component.handleInput("\r");
					}),
				},
			};
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
			await command.handler("", ctx);
			return { tools, transitions };
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	}

	const inactive = await run("off");
	const active = await run("terrific-native-v1");
	assert.deepEqual(active, inactive);
	assert.deepEqual(active.tools, ["read", "grep", "find", "ls"]);
});
