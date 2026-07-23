import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import presentation from "../extensions/presentation.ts";
import {
	PRESENTATION_ARTIFACT_STATE_ENTRY_TYPE,
	PRESENTATION_EVENT_NAME,
	PRESENTATION_SYSTEM_ENTRY_TYPE,
} from "../lib/types.ts";

function createHarness(
	mode: "tui" | "print" | "rpc" = "tui",
	menuChoices: string[] = [],
	cwd = "/workspace/terrific-pi",
	availableCommands: string[] = ["skill:foo"],
) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const eventHandlers = new Map<string, Array<(value: unknown) => void>>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const commands = new Map<string, any>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const entryRenderers = new Map<string, unknown>();
	const tools = new Map<string, unknown>();
	let customCalls = 0;
	const ctx = {
		cwd,
		mode,
		hasUI: mode === "tui",
		model: { provider: "openai", id: "gpt-test" },
		ui: {
			notify(message: string, level?: string) { notifications.push({ message, level }); },
			async custom() { customCalls += 1; return menuChoices.shift(); },
			async input() { return undefined; },
			async confirm() { return false; },
			async select() { return menuChoices.shift(); },
		},
		sessionManager: { getBranch: () => [], getLeafId: () => "request-1" },
	};
	const pi = {
		on(name: string, handler: (event: any, eventCtx: any) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: {
			on(name: string, handler: (value: unknown) => void) {
				eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
				return () => eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((item) => item !== handler));
			},
			emit(name: string, value: unknown) {
				for (const handler of eventHandlers.get(name) ?? []) handler(value);
			},
		},
		appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
		registerEntryRenderer(type: string, renderer: unknown) { entryRenderers.set(type, renderer); },
		registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: unknown) { commands.set(name, command); },
		getCommands() { return availableCommands.map((name) => ({ name, source: name.startsWith("skill:") ? "skill" : "test" })); },
		getThinkingLevel() { return "high"; },
		async exec(_command: string, args: string[]) {
			if (args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "", killed: false };
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	};
	presentation(pi as never);
	return {
		ctx,
		entries,
		commands,
		notifications,
		entryRenderers,
		tools,
		get customCalls() { return customCalls; },
		emitEvent(name: string, value: unknown) { pi.events.emit(name, value); },
		async emit(name: string, event: any = {}) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) {
				const next = await handler({ type: name, ...event }, ctx);
				if (next !== undefined) result = next;
			}
			return result as any;
		},
	};
}

test("presentation appends UI-only system events without owning built-in execution tools", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "presentation-extension-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({ presentation: { enabled: true } }), "utf8");
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const harness = createHarness();
		assert.ok(harness.commands.has("presentation"));
		assert.ok(harness.entryRenderers.has(PRESENTATION_SYSTEM_ENTRY_TYPE));
		assert.deepEqual([...harness.tools.keys()], []);
		const first = await harness.emit("before_agent_start", {
			systemPrompt: "base",
			systemPromptOptions: { contextFiles: [{ path: "AGENTS.md" }, { path: "project/AGENTS.md" }] },
		});
		assert.match(first.systemPrompt, /Presentation contract:/);
		assert.equal(harness.entries.filter((entry) => entry.customType === PRESENTATION_SYSTEM_ENTRY_TYPE).length, 1);
		await harness.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } });
		assert.equal(harness.entries.filter((entry) => entry.customType === PRESENTATION_SYSTEM_ENTRY_TYPE).length, 1);

		const modeEvent: Record<string, unknown> = {
			version: 1,
			kind: "mode",
			source: "user",
			tone: "info",
			label: "Mode",
			message: "PLAN · read-only",
			dedupeKey: "mode:plan",
		};
		harness.emitEvent(PRESENTATION_EVENT_NAME, modeEvent);
		assert.match(JSON.stringify(harness.entries.at(-1)?.data), /PLAN/);
		assert.equal(modeEvent.presentationHandled, true);
		await harness.emit("input", { text: "/skill:foo" });
		assert.match(JSON.stringify(harness.entries.at(-1)?.data), /Skill\(foo\)/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("presentation reports canonical taskboard availability with process compatibility fallback", async () => {
	for (const [commands, expected] of [
		[["taskboard", "process"], "taskboard=available"],
		[["process"], "taskboard=available"],
		[["skill:foo"], "taskboard=missing"],
	] as const) {
		const harness = createHarness("tui", [], "/workspace/terrific-pi", [...commands]);
		await harness.commands.get("presentation").handler("status", harness.ctx);
		const message = harness.notifications.at(-1)?.message ?? "";
		assert.match(message, new RegExp(expected));
		assert.doesNotMatch(message, /process-view/);
	}
});

test("presentation keeps tool semantics in native history without durable duplicate summaries", async () => {
	const harness = createHarness();
	await harness.emit("before_agent_start", {
		systemPrompt: "base",
		systemPromptOptions: {
			contextFiles: [],
			skills: [{ name: "release-notes", filePath: "/home/user/.agents/skills/release-notes/SKILL.md" }],
		},
	});
	await harness.emit("tool_execution_start", {
		toolCallId: "skill-read",
		toolName: "read",
		args: { path: "/home/user/.agents/skills/release-notes/SKILL.md" },
	});
	await harness.emit("tool_execution_end", {
		toolCallId: "skill-read",
		toolName: "read",
		result: { content: [] },
		isError: false,
	});
	await harness.emit("tool_execution_start", {
		toolCallId: "read-src",
		toolName: "read",
		args: { path: "src/app.ts" },
	});
	await harness.emit("tool_execution_end", {
		toolCallId: "read-src",
		toolName: "read",
		result: { content: [] },
		isError: false,
	});
	await harness.emit("turn_end", {
		turnIndex: 1,
		toolResults: [
			{ toolCallId: "skill-read", toolName: "read" },
			{ toolCallId: "read-src", toolName: "read" },
		],
	});
	assert.equal(
		harness.entries.filter((entry) => entry.customType === "presentation-tools-v1").length,
		0,
	);
});

test("presentation debounces model and thinking selection into one system entry", async () => {
	const harness = createHarness();
	await harness.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } });
	await harness.emit("model_select", { source: "set", model: { provider: "grok", id: "grok-4.5" } });
	await harness.emit("thinking_level_select", { level: "max" });
	await new Promise((resolve) => setTimeout(resolve, 130));
	const modelEntries = harness.entries.filter((entry) => {
		const data = entry.data as { kind?: string };
		return entry.customType === PRESENTATION_SYSTEM_ENTRY_TYPE && data.kind === "model";
	});
	assert.equal(modelEntries.length, 1);
	assert.match(JSON.stringify(modelEntries[0]?.data), /grok\/grok-4\.5.*thinking max/);
});

test("presentation persists one request artifact state for a tool-bearing turn", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-extension-artifacts-"));
	try {
		const path = join(workspace, "app.ts");
		writeFileSync(path, "old\n", "utf8");
		const harness = createHarness("tui", [], workspace);
		await harness.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } });
		await harness.emit("tool_execution_start", { toolCallId: "edit-1", toolName: "edit", args: { path: "app.ts" } });
		await harness.emit("tool_call", { toolCallId: "edit-1", toolName: "edit", input: { path: "app.ts" } });
		writeFileSync(path, "new\n", "utf8");
		await harness.emit("tool_result", { toolCallId: "edit-1", toolName: "edit", input: { path: "app.ts" } });
		await harness.emit("tool_execution_end", {
			toolCallId: "edit-1",
			toolName: "edit",
			result: { content: [{ type: "text", text: "done" }], details: { diff: "-1 old\n+1 new" } },
			isError: false,
		});
		await harness.emit("turn_end", {
			turnIndex: 1,
			toolResults: [{ toolCallId: "edit-1", toolName: "edit" }],
		});
		const receipts = harness.entries.filter((entry) => entry.customType === PRESENTATION_ARTIFACT_STATE_ENTRY_TYPE);
		assert.equal(receipts.length, 1);
		assert.match(JSON.stringify(receipts[0]?.data), /app\.ts/);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("presentation journals the final tool_call input rather than preflight arguments", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "presentation-extension-final-input-"));
	try {
		const harness = createHarness("tui", [], workspace);
		await harness.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } });
		await harness.emit("tool_execution_start", { toolCallId: "write-1", toolName: "write", args: { path: "stale.ts", content: "stale" } });
		await harness.emit("tool_call", { toolCallId: "write-1", toolName: "write", input: { path: "final.ts", content: "final" } });
		writeFileSync(join(workspace, "final.ts"), "final", "utf8");
		await harness.emit("tool_result", { toolCallId: "write-1", toolName: "write", input: { path: "final.ts", content: "final" } });
		await harness.emit("tool_execution_end", {
			toolCallId: "write-1",
			toolName: "write",
			result: { content: [] },
			isError: false,
		});
		await harness.emit("turn_end", {
			turnIndex: 1,
			toolResults: [{ toolCallId: "write-1", toolName: "write" }],
		});
		const receipts = harness.entries.filter((entry) => entry.customType === PRESENTATION_ARTIFACT_STATE_ENTRY_TYPE);
		assert.match(JSON.stringify(receipts[0]?.data), /final\.ts/);
		assert.doesNotMatch(JSON.stringify(receipts[0]?.data), /stale\.ts/);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("presentation defers changed tool inputs to Git reconciliation instead of misattributing them", async () => {
	const harness = createHarness();
	await harness.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } });
	await harness.emit("tool_execution_start", { toolCallId: "write-1", toolName: "write", args: { path: "src/stale.ts", content: "stale" } });
	await harness.emit("tool_call", { toolCallId: "write-1", toolName: "write", input: { path: "src/original.ts", content: "original" } });
	await harness.emit("tool_result", { toolCallId: "write-1", toolName: "write", input: { path: "src/rewritten.ts", content: "rewritten" } });
	await harness.emit("tool_execution_end", {
		toolCallId: "write-1",
		toolName: "write",
		result: { content: [] },
		isError: false,
	});
	await harness.emit("turn_end", {
		turnIndex: 1,
		toolResults: [{ toolCallId: "write-1", toolName: "write" }],
	});
	assert.equal(harness.entries.filter((entry) => entry.customType === "presentation-artifacts-v1").length, 0);
});

test("bare presentation opens a TUI configuration menu and persists its selection", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "presentation-menu-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({ presentation: { enabled: true, systemEvents: true } }), "utf8");
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const harness = createHarness("tui", ["System entries: on", "Done"]);
		const command = harness.commands.get("presentation");
		await command.handler("", harness.ctx);
		const saved = JSON.parse(readFileSync(join(agentDir, "terrific.json"), "utf8"));
		assert.equal(saved.presentation.systemEvents, false);
		assert.equal(harness.customCalls, 2);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("presentation does not append visual entries outside TUI mode", async () => {
	for (const mode of ["print", "rpc"] as const) {
		const harness = createHarness(mode);
		await harness.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } });
		assert.equal(harness.entries.length, 0, mode);
	}
});
