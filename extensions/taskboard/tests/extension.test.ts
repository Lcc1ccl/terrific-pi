import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import taskboard from "../extensions/taskboard.ts";
import { createPersistedState, normalizeProcessUpdate, syncProcessTelemetry } from "../lib/state.ts";
import {
	TASKBOARD_CONTEXT_TYPE,
	TASKBOARD_ENTRY_TYPE,
	TASKBOARD_STATUS_KEY,
	TASKBOARD_WIDGET_KEY,
	type ProcessSnapshot,
	type ProcessUpdateInput,
} from "../lib/types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function runningInput(): ProcessUpdateInput {
	return {
		title: "Implement process view",
		status: "running" as const,
		steps: [
			{ text: "Inspect", status: "done" as const },
			{ text: "Implement", status: "active" as const },
			{ text: "Verify", status: "pending" as const },
		],
		update: "Implementation started",
		artifacts: [{ kind: "file" as const, label: "process-view.ts", ref: "/private/process-view.ts" }],
	};
}

function completedInput(): ProcessUpdateInput {
	return {
		...runningInput(),
		status: "completed" as const,
		steps: runningInput().steps.map((step) => ({ ...step, status: "done" as const })),
		update: "Implementation verified",
		verification: "All checks passed",
	};
}

interface HarnessOptions {
	mode?: "tui" | "print" | "rpc" | "json";
	branch?: unknown[];
	throwWidget?: boolean;
	toolsExpanded?: boolean;
	choices?: string[];
	confirmations?: boolean[];
	terminalRows?: number;
}

async function withAppearanceProfile<T>(active: boolean, run: () => Promise<T>): Promise<T> {
	const agentDir = mkdtempSync(join(tmpdir(), "taskboard-profile-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	writeFileSync(join(agentDir, "terrific.json"), JSON.stringify(active
		? { appearance: { profile: "terrific-native-v1" } }
		: {}));
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		return await run();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

interface FakeTimer {
	callback: () => void;
	ms: number;
	unref(): void;
}

async function withFakeIntervals<T>(run: (timers: {
	active: Set<FakeTimer>;
	started: FakeTimer[];
	cleared: FakeTimer[];
}) => Promise<T>): Promise<T> {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const active = new Set<FakeTimer>();
	const started: FakeTimer[] = [];
	const cleared: FakeTimer[] = [];
	globalThis.setInterval = ((callback: () => void, ms: number) => {
		const timer: FakeTimer = { callback, ms, unref() {} };
		active.add(timer);
		started.push(timer);
		return timer;
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = ((timer: FakeTimer) => {
		active.delete(timer);
		cleared.push(timer);
	}) as unknown as typeof clearInterval;
	try {
		return await run({ active, started, cleared });
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
}

function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const entries: any[] = [...(options.branch ?? [])];
	const notifications: Array<{ message: string; type?: string }> = [];
	const hiddenLabels: Array<string | undefined> = [];
	const widgetCalls: Array<{ key: string; content: unknown }> = [];
	const statusCalls: Array<{ key: string; value: string | undefined }> = [];
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const confirmCalls: Array<{ title: string; message: string }> = [];
	const choices = [...(options.choices ?? [])];
	const confirmations = [...(options.confirmations ?? [])];
	const shortcuts: unknown[] = [];
	let tool: any;
	const commands = new Map<string, any>();
	let failAppend = false;
	let currentWidget: any;
	let renderRequests = 0;
	let toolsExpanded = options.toolsExpanded ?? false;
	const terminal = { rows: options.terminalRows ?? 24 };
	const tui = {
		requestRender: () => { renderRequests += 1; },
		terminal,
	};

	const ui = {
		setWidget(key: string, content: unknown) {
			if (options.throwWidget) throw new Error("widget unavailable");
			widgetCalls.push({ key, content });
			if (typeof content === "function") {
				currentWidget = content(tui, theme);
			} else if (content === undefined) {
				currentWidget = undefined;
			}
		},
		setHiddenThinkingLabel(label?: string) {
			hiddenLabels.push(label);
		},
		getToolsExpanded() {
			return toolsExpanded;
		},
		setToolsExpanded(value: boolean) {
			toolsExpanded = value;
		},
		async select(title: string, items: string[]) {
			selectCalls.push({ title, options: [...items] });
			const prefix = choices.shift();
			if (prefix === undefined) return undefined;
			return items.find((item) => item === prefix || item.startsWith(prefix));
		},
		async custom(factory: any) {
			return new Promise<string | undefined>((resolve, reject) => {
				const component = factory(
					{ requestRender() {} },
					theme,
					{
						matches: (data: string, binding: string) =>
							(data === "\x1b[A" && binding === "tui.select.up")
							|| (data === "\x1b[B" && binding === "tui.select.down")
							|| (data === "\r" && binding === "tui.select.confirm")
							|| (data === "\x1b" && binding === "tui.select.cancel"),
						getKeys: () => [],
					},
					resolve,
				);
				const render = () => component.render(200).join("\n");
				selectCalls.push({ title: render(), options: [] });
				const prefix = choices.shift();
				if (prefix === undefined) {
					component.handleInput("\x1b");
					return;
				}
				for (let index = 0; index < 32; index++) {
					const selected = render().split("\n").find((line: string) => line.trimStart().startsWith("→"));
					if (selected?.includes(prefix)) {
						component.handleInput("\r");
						return;
					}
					component.handleInput("\x1b[B");
				}
				reject(new Error(`Menu option not found: ${prefix}`));
			});
		},
		async confirm(title: string, message: string) {
			confirmCalls.push({ title, message });
			return confirmations.shift() ?? false;
		},
		notify(message: string, type?: string) {
			notifications.push({ message, type });
		},
		setStatus(key: string, value: string | undefined) {
			statusCalls.push({ key, value });
		},
		setFooter() {
			throw new Error("setFooter must not be called");
		},
		setWorkingMessage() {
			throw new Error("setWorkingMessage must not be called");
		},
	};
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: (options.mode ?? "tui") === "tui",
		cwd: "/workspace/project",
		ui,
		sessionManager: { getBranch: () => entries },
		isIdle: () => true,
	};
	const pi = {
		on(name: string, handler: (event: any, eventCtx: any) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(value: unknown) {
			tool = value;
		},
		registerCommand(name: string, value: unknown) {
			commands.set(name, value);
		},
		registerShortcut(value: unknown) {
			shortcuts.push(value);
		},
		appendEntry(customType: string, data: unknown) {
			if (failAppend) throw new Error("session write failed");
			entries.push({ type: "custom", customType, data });
		},
	};
	taskboard(pi as never);

	return {
		ctx,
		entries,
		notifications,
		hiddenLabels,
		widgetCalls,
		statusCalls,
		selectCalls,
		confirmCalls,
		shortcuts,
		get tool() { return tool; },
		get command() { return commands.get("taskboard"); },
		get processAlias() { return commands.get("process"); },
		get currentWidget() { return currentWidget; },
		get renderRequests() { return renderRequests; },
		terminal,
		tui,
		setFailAppend(value: boolean) { failAppend = value; },
		setToolsExpanded(value: boolean) { toolsExpanded = value; },
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

async function execute(harness: ReturnType<typeof createHarness>, input = runningInput()) {
	return harness.tool.execute("process-1", input, undefined, undefined, harness.ctx);
}

function latestSnapshot(entries: any[]): ProcessSnapshot | undefined {
	return [...entries].reverse().find((entry) => entry.customType === TASKBOARD_ENTRY_TYPE)?.data.snapshot;
}

describe("taskboard registration and tool", () => {
	it("rereads terrific style within one extension generation and keeps tool results baseline", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-profile-generation-"));
		const path = join(agentDir, "terrific.json");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousTerm = process.env.TERM;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.TERM = "xterm-256color";
			writeFileSync(path, "{");
			const malformed = createHarness();
			await execute(malformed);
			assert.deepEqual(malformed.notifications, []);
			assert.doesNotMatch(malformed.currentWidget.render(100).join("\n"), /▶/);

			writeFileSync(path, "{}");
			const live = createHarness({ terminalRows: 16 });
			writeFileSync(path, JSON.stringify({ appearance: { profile: "terrific-native-v1" } }));
			await live.emit("session_start", { reason: "startup" });
			const result = await execute(live);
			assert.match(live.currentWidget.render(100).join("\n"), /▶ Implement/);
			live.setToolsExpanded(true);
			assert.ok(live.currentWidget.render(100).length <= 10);

			process.env.TERM = "dumb";
			const ascii = createHarness();
			await execute(ascii);
			assert.match(ascii.currentWidget.render(100).join("\n"), /> Implement/);

			await execute(live, completedInput());
			assert.deepEqual(live.tool.renderResult(
				result,
				{ expanded: true },
				theme,
				{ isError: false },
			).render(120).map((line: string) => line.trimEnd()), [
				"● Running · 1/3 Implement process view",
				"✓ Inspect",
				"● Implement · 0s",
				"○ Verify",
				"Update: Implementation started",
				"Runtime: — · 0 turns · ↑0 ↓0 · R0 W0",
				"Artifacts: process-view.ts",
			]);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("remounts an active Widget when a command observes a profile edit", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-command-profile-"));
		const path = join(agentDir, "terrific.json");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			writeFileSync(path, JSON.stringify({ appearance: { profile: "terrific-native-v1" } }), "utf8");
			const harness = createHarness();
			await execute(harness);
			assert.match(harness.currentWidget.render(100).join("\n"), /▶ Implement/);

			writeFileSync(path, JSON.stringify({ appearance: { profile: "off" } }), "utf8");
			await harness.command.handler("default compact", harness.ctx);
			assert.ok(harness.currentWidget);
			assert.doesNotMatch(harness.currentWidget.render(100).join("\n"), /▶ Implement/);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("resizes the same mounted terrific Widget from live terminal rows", async () => {
		await withAppearanceProfile(true, async () => {
			const harness = createHarness({ terminalRows: 24, toolsExpanded: true });
			await execute(harness, {
				...runningInput(),
				steps: [
					{ text: "Inspect", status: "done" },
					{ text: "Implement", status: "active" },
					{ text: "Verify", status: "pending" },
					{ text: "Review", status: "pending" },
					{ text: "Report", status: "pending" },
				],
				verification: "Focused checks pending",
			});
			const widget = harness.currentWidget;
			const tui = harness.tui;
			const widgetCallCount = harness.widgetCalls.length;
			for (const [rows, expectedLines] of [[24, 15], [16, 10], [20, 12], [24, 15]] as const) {
				harness.terminal.rows = rows;
				const lines = widget.render(120);
				assert.equal(lines.length, expectedLines, `${rows} terminal rows`);
				assert.match(lines.at(-1) ?? "", /╯$/);
				assert.strictEqual(harness.currentWidget, widget);
				assert.strictEqual(harness.tui, tui);
				assert.equal(harness.widgetCalls.length, widgetCallCount);
			}
		});
	});

	it("registers only the canonical taskboard command and keeps process_update", () => {
		const harness = createHarness();
		assert.equal(harness.tool.name, "process_update");
		assert.equal(harness.tool.label, "Taskboard update");
		assert.equal(harness.tool.executionMode, "sequential");
		assert.equal(harness.tool.renderShell, "self");
		assert.ok(harness.tool.promptGuidelines.every((line: string) => line.includes("process_update")));
		assert.ok(harness.command);
		assert.equal(harness.processAlias, undefined);
		assert.deepEqual(harness.command.getArgumentCompletions("").map((item: { value: string }) => item.value), [
			"compact", "full", "off", "clear", "default",
		]);
		assert.deepEqual(harness.command.getArgumentCompletions("default ").map((item: { value: string }) => item.value), [
			"default compact", "default full", "default off",
		]);
		assert.deepEqual(harness.shortcuts, []);
	});

	it("keeps legacy session entry and context type strings for restoration", () => {
		assert.equal(TASKBOARD_ENTRY_TYPE, "process-view-state-v1");
		assert.equal(TASKBOARD_CONTEXT_TYPE, "process-view-context");
	});

	it("executes the canonical default migration", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-process-alias-"));
		const path = join(agentDir, "terrific.json");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		writeFileSync(path, JSON.stringify({ processView: { activityMode: "task", legacyOnly: true } }));
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const harness = createHarness();
			await harness.command.handler("default off", harness.ctx);
			assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
				taskboard: { activityMode: "task", legacyOnly: true, defaultViewMode: "off" },
			});
			assert.match(harness.notifications.at(-1)?.message ?? "", /Taskboard default.*off/i);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("persists normalized details before committing UI state", async () => {
		const harness = createHarness();
		const result = await execute(harness);
		assert.match(result.content[0].text, /Taskboard state updated: 1\/3 running/);
		const { telemetry, ...detailsSnapshot } = result.details;
		assert.deepEqual(harness.entries[0].data.snapshot, detailsSnapshot);
		assert.deepEqual(harness.entries[0].data.telemetry, telemetry);
		assert.equal(harness.entries[0].customType, TASKBOARD_ENTRY_TYPE);
		assert.equal(harness.widgetCalls[0]?.key, TASKBOARD_WIDGET_KEY);
		assert.ok(harness.currentWidget.render(100).join("\n").includes("Implement process view"));
	});

	it("includes assistant usage emitted before the first process snapshot", async () => {
		const harness = createHarness();
		await harness.emit("before_agent_start", { prompt: "implement process view" });
		await harness.emit("message_end", {
			message: {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.6-sol",
				usage: {
					input: 8_000,
					output: 500,
					cacheRead: 6_000,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.08 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		});
		const result = await execute(harness);
		assert.equal(result.details.telemetry.turns, 1);
		assert.equal(result.details.telemetry.usage.input, 8_000);
		assert.equal(result.details.telemetry.steps[1].turns, 1);
	});

	it("throws semantic errors without state, entry, or UI changes", async () => {
		const harness = createHarness();
		await assert.rejects(
			() => execute(harness, {
				...runningInput(),
				steps: runningInput().steps.map((step) => ({ ...step, status: "pending" as const })),
			}),
			/exactly one active/i,
		);
		assert.deepEqual(harness.entries, []);
		assert.deepEqual(harness.widgetCalls, []);
		await harness.command.handler("", harness.ctx);
		assert.match(harness.selectCalls.at(-1)?.title ?? "", /no active task/i);
	});

	it("keeps in-memory state unchanged when appendEntry fails", async () => {
		const harness = createHarness();
		harness.setFailAppend(true);
		await assert.rejects(() => execute(harness), /session write failed/);
		harness.setFailAppend(false);
		await harness.command.handler("", harness.ctx);
		assert.match(harness.selectCalls.at(-1)?.title ?? "", /no active task/i);
		assert.deepEqual(harness.entries, []);
	});

	it("completes an eligible final step from a verified git finalize receipt", async () => {
		const harness = createHarness();
		await execute(harness, {
			title: "Release presentation",
			status: "running",
			steps: [
				{ text: "Implement", status: "done" },
				{ text: "Verify", status: "done" },
				{ text: "Commit", status: "active" },
			],
			update: "Ready to commit",
			artifacts: [
				{ kind: "commit", label: "Old commit", ref: "1111111" },
				{ kind: "test", label: "Package checks" },
			],
		});
		assert.equal(await harness.emit("tool_call", { toolName: "git_finalize", toolCallId: "git-1", input: {} }), undefined);
		await harness.emit("tool_result", {
			toolName: "git_finalize",
			toolCallId: "git-1",
			input: {},
			content: [{ type: "text", text: "Committed abcdef123456" }],
			isError: false,
			details: {
				kind: "git_finalize",
				version: 1,
				status: "committed",
				commit: "abcdef123456",
				requestedPush: false,
				operationSatisfied: true,
			},
		});
		const snapshot = latestSnapshot(harness.entries)!;
		assert.equal(snapshot.status, "completed");
		assert.deepEqual(snapshot.steps.map((step) => step.status), ["done", "done", "done"]);
		assert.match(snapshot.update ?? "", /Committed abcdef123456/);
		assert.deepEqual(snapshot.artifacts, [
			{ kind: "test", label: "Package checks" },
			{ kind: "commit", label: "Committed abcdef123456", ref: "abcdef123456" },
		]);
	});

	it("ignores a malformed git finalize receipt", async () => {
		const harness = createHarness();
		await execute(harness, {
			title: "Release presentation",
			status: "running",
			steps: [
				{ text: "Implement", status: "done" },
				{ text: "Commit", status: "active" },
			],
			update: "Ready to commit",
		});
		await harness.emit("tool_result", {
			toolName: "git_finalize",
			toolCallId: "git-1",
			input: {},
			content: [{ type: "text", text: "Committed not-a-hash" }],
			isError: false,
			details: {
				kind: "git_finalize",
				version: 1,
				status: "committed",
				commit: "not-a-hash",
				requestedPush: false,
				operationSatisfied: true,
			},
		});
		assert.equal(latestSnapshot(harness.entries)?.status, "running");
	});

	it("keeps the task waiting when a requested push only partially succeeds", async () => {
		const harness = createHarness();
		await execute(harness, {
			title: "Release presentation",
			status: "running",
			steps: [
				{ text: "Implement", status: "done" },
				{ text: "Verify", status: "done" },
				{ text: "Push", status: "active" },
			],
			update: "Ready to push",
		});
		await harness.emit("tool_result", {
			toolName: "git_finalize",
			toolCallId: "git-1",
			input: {},
			content: [{ type: "text", text: "Committed abcdef123456; push failed" }],
			isError: false,
			details: {
				kind: "git_finalize",
				version: 1,
				status: "partial",
				commit: "abcdef123456",
				requestedPush: true,
				operationSatisfied: false,
				pushError: "offline",
			},
		});
		const snapshot = latestSnapshot(harness.entries)!;
		assert.equal(snapshot.status, "waiting");
		assert.equal(snapshot.steps.at(-1)?.status, "failed");
		assert.match(snapshot.update ?? "", /push failed: offline/);
	});

	it("blocks git finalize before the final process step is ready", async () => {
		const harness = createHarness();
		await execute(harness);
		assert.deepEqual(
			await harness.emit("tool_call", { toolName: "git_finalize", toolCallId: "git-1", input: {} }),
			{ block: true, reason: "git_finalize can complete Taskboard only when its final active step is ready to commit" },
		);
	});

	it("returns a tool result even when Widget rendering fails", async () => {
		const harness = createHarness({ throwWidget: true });
		const result = await execute(harness);
		assert.equal(result.details.title, "Implement process view");
		assert.equal(harness.entries.length, 1);
		assert.match(harness.notifications[0]?.message ?? "", /Taskboard UI/i);
	});

	it("suppresses only active-profile current receipts while retaining baseline history", async () => {
		await withAppearanceProfile(false, async () => {
			const harness = createHarness();
			const current = await execute(harness);
			assert.deepEqual(
				harness.tool.renderResult(current, { expanded: true }, theme, { isError: false })
					.render(120).map((line: string) => line.trimEnd()),
				[
					"● Running · 1/3 Implement process view",
					"✓ Inspect",
					"● Implement · 0s",
					"○ Verify",
					"Update: Implementation started",
					"Runtime: — · 0 turns · ↑0 ↓0 · R0 W0",
					"Artifacts: process-view.ts",
				],
			);
		});

		await withAppearanceProfile(true, async () => {
			const harness = createHarness();
			const running = await execute(harness);
			assert.deepEqual(
				harness.tool.renderResult(running, { expanded: false }, theme, { isError: false }).render(120),
				[],
			);
			assert.deepEqual(
				harness.tool.renderResult(running, { expanded: true }, theme, { isError: false }).render(120),
				[],
			);
			for (const expanded of [false, true]) {
				assert.deepEqual(harness.tool.renderResult(
					{ ...running, content: [{ type: "text", text: "Invalid update" }] },
					{ expanded },
					theme,
					{ isError: true },
				).render(120).map((line: string) => line.trimEnd()), ["Invalid update"]);
			}

			const completed = await execute(harness, completedInput());
			const historical = harness.tool.renderResult(
				running,
				{ expanded: true },
				theme,
				{ isError: false },
			).render(120).join("\n");
			for (const step of ["Inspect", "Implement", "Verify"]) assert.match(historical, new RegExp(step));

			await harness.emit("agent_settled");
			assert.equal(harness.currentWidget, undefined);
			const final = harness.tool.renderResult(
				completed,
				{ expanded: true },
				theme,
				{ isError: false },
			).render(120).join("\n");
			for (const step of ["Inspect", "Implement", "Verify"]) assert.match(final, new RegExp(step));
		});
	});
});

describe("request, branch, and context lifecycle", () => {
	it("rereads activityMode before the next request", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-live-config-"));
		const path = join(agentDir, "terrific.json");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			writeFileSync(path, JSON.stringify({ taskboard: { activityMode: "off" } }), "utf8");
			const harness = createHarness();
			await harness.emit("session_start", { reason: "startup" });
			writeFileSync(path, JSON.stringify({ taskboard: { activityMode: "full" } }), "utf8");
			await harness.emit("before_agent_start", { prompt: "start" });
			assert.ok(harness.currentWidget);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
	it("fails closed by persisting a tombstone for corrupt branch state", async () => {
		const harness = createHarness({
			branch: [{
				type: "custom",
				customType: TASKBOARD_ENTRY_TYPE,
				data: { version: 2, viewMode: "full", cleared: false },
			}],
		});
		await harness.emit("session_start", { reason: "resume" });
		assert.deepEqual(harness.entries.at(-1)?.data, { version: 1, viewMode: "compact", cleared: true });
		assert.match(harness.notifications[0]?.message ?? "", /invalid.*cleared/i);
		const count = harness.notifications.length;
		await harness.emit("session_tree", { newLeafId: "same", oldLeafId: "same" });
		assert.equal(harness.notifications.length, count);
	});

	it("restores branch state and configures only TUI-owned UI", async () => {
		const stored = createPersistedState(normalizeProcessUpdate({
			...runningInput(),
			status: "waiting",
		}), "full");
		const harness = createHarness({ branch: [{ type: "custom", customType: TASKBOARD_ENTRY_TYPE, data: stored }] });
		await harness.emit("session_start", { reason: "resume" });
		assert.equal(harness.widgetCalls[0]?.key, TASKBOARD_WIDGET_KEY);
		assert.deepEqual(harness.hiddenLabels, []);

		const print = createHarness({ mode: "print", branch: [{ type: "custom", customType: TASKBOARD_ENTRY_TYPE, data: stored }] });
		await print.emit("session_start", { reason: "resume" });
		assert.deepEqual(print.widgetCalls, []);
		assert.deepEqual(print.hiddenLabels, []);
		assert.equal((await execute(print)).details.status, "running");
	});

	it("pauses a stale running timer when restoring an idle session", async () => {
		const snapshot = normalizeProcessUpdate(runningInput(), undefined, 1_000);
		const stored = createPersistedState(
			snapshot,
			"compact",
			syncProcessTelemetry(undefined, undefined, snapshot, 1_000),
		);
		const harness = createHarness({ branch: [{ type: "custom", customType: TASKBOARD_ENTRY_TYPE, data: stored }] });
		await harness.emit("session_start", { reason: "resume" });
		const restored = harness.entries.at(-1)?.data;
		assert.equal(restored.snapshot.status, "waiting");
		assert.equal(restored.telemetry.steps[1].activeSince, undefined);
		assert.equal(restored.telemetry.steps[1].activeMs, 0);
	});

	it("writes a request tombstone and consumes the previous task reminder once", async () => {
		const harness = createHarness();
		await execute(harness, { ...runningInput(), status: "waiting" });
		const entryCount = harness.entries.length;
		await harness.emit("before_agent_start", { prompt: "new request" });
		assert.equal(harness.entries.length, entryCount + 1);
		assert.deepEqual(harness.entries.at(-1)?.data, { version: 1, viewMode: "compact", cleared: true });

		const first = await harness.emit("context", { messages: [{ role: "user", content: "new request" }] });
		assert.equal(first.messages.length, 2);
		assert.equal(first.messages[1].role, "custom");
		assert.equal(first.messages[1].customType, TASKBOARD_CONTEXT_TYPE);
		assert.equal(first.messages[1].display, false);
		assert.doesNotMatch(first.messages[1].content, /\/private\/|verification/i);
		assert.equal(await harness.emit("context", { messages: [] }), undefined);

		await harness.emit("agent_settled");
		assert.equal(harness.currentWidget, undefined);
		await harness.emit("session_start", { reason: "reload" });
		assert.equal(harness.currentWidget, undefined);
	});

	it("clears a mounted Widget when tree navigation lands on a tombstone", async () => {
		const harness = createHarness();
		await execute(harness);
		assert.ok(harness.currentWidget);
		harness.entries.push({
			type: "custom",
			customType: TASKBOARD_ENTRY_TYPE,
			data: { version: 1, viewMode: "compact", cleared: true },
		});
		await harness.emit("session_tree", { newLeafId: "tombstone", oldLeafId: "work" });
		assert.equal(harness.currentWidget, undefined);
	});

	it("injects a compacted unfinished snapshot once without persisting it", async () => {
		const harness = createHarness();
		await execute(harness);
		const entryCount = harness.entries.length;
		await harness.emit("session_compact", { reason: "manual", willRetry: false });
		const first = await harness.emit("context", { messages: [] });
		assert.equal(first.messages[0].customType, TASKBOARD_CONTEXT_TYPE);
		assert.equal(harness.entries.length, entryCount);
		assert.equal(await harness.emit("context", { messages: [] }), undefined);
	});

	it("does not persist transient retry errors but persists final interruption", async () => {
		const retry = createHarness();
		await execute(retry);
		await retry.emit("turn_end", { message: { role: "assistant", stopReason: "error" }, toolResults: [] });
		await retry.emit("agent_start");
		await retry.emit("turn_end", { message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		await retry.emit("agent_settled");
		assert.equal(latestSnapshot(retry.entries)?.status, "waiting");

		const final = createHarness();
		await execute(final);
		await final.emit("turn_end", { message: { role: "assistant", stopReason: "error" }, toolResults: [] });
		await final.emit("agent_settled");
		assert.equal(latestSnapshot(final.entries)?.status, "interrupted");
		assert.equal(latestSnapshot(final.entries)?.update, "Run stopped after an error");
	});

	it("hides completed work after settled while retaining its receipt entry", async () => {
		const harness = createHarness();
		await execute(harness, completedInput());
		assert.ok(harness.currentWidget);
		await harness.emit("agent_settled");
		assert.equal(harness.currentWidget, undefined);
		assert.equal(latestSnapshot(harness.entries)?.status, "completed");
	});

	it("publishes waiting/blocked footer status for statusline and clears it when idle", async () => {
		const harness = createHarness();
		await execute(harness, { ...runningInput(), status: "waiting" });
		assert.deepEqual(harness.statusCalls.at(-1), { key: TASKBOARD_STATUS_KEY, value: "waiting" });

		await execute(harness, { ...runningInput(), status: "blocked", blocker: "Need decision" });
		assert.deepEqual(harness.statusCalls.at(-1), { key: TASKBOARD_STATUS_KEY, value: "blocked" });

		await execute(harness, completedInput());
		assert.deepEqual(harness.statusCalls.at(-1), { key: TASKBOARD_STATUS_KEY, value: undefined });

		await harness.emit("session_shutdown", { reason: "quit" });
		assert.deepEqual(harness.statusCalls.at(-1), { key: TASKBOARD_STATUS_KEY, value: undefined });
	});
});

describe("duration timer lifecycle", () => {
	it("runs one 1000ms timer only for a visible running snapshot with active telemetry", async () => {
		await withFakeIntervals(async ({ active, started, cleared }) => {
			const harness = createHarness();
			assert.equal(started.length, 0);
			await execute(harness);
			assert.equal(started.length, 1);
			assert.equal(started[0]?.ms, 1_000);
			assert.equal(active.size, 1);

			await harness.emit("message_update", { assistantMessageEvent: { type: "text_delta" } });
			assert.equal(started.length, 1);
			assert.equal(active.size, 1);

			await execute(harness, { ...runningInput(), status: "waiting" });
			assert.equal(active.size, 0);
			assert.equal(cleared.length, 1);

			await execute(harness);
			assert.equal(active.size, 1);
			await harness.command.handler("off", harness.ctx);
			assert.equal(active.size, 0);
			assert.equal(harness.currentWidget, undefined);

			await harness.command.handler("compact", harness.ctx);
			assert.equal(active.size, 1);
			await execute(harness, completedInput());
			assert.equal(active.size, 0);
			await harness.emit("agent_settled");
			assert.equal(harness.currentWidget, undefined);

			const settled = createHarness();
			await execute(settled);
			assert.equal(active.size, 1);
			await settled.emit("agent_settled");
			assert.equal(active.size, 0);

			const shutdown = createHarness();
			await execute(shutdown);
			assert.equal(active.size, 1);
			const startsBeforeShutdown = started.length;
			const statusesBeforeShutdown = shutdown.statusCalls.length;
			await shutdown.emit("session_shutdown", { reason: "reload" });
			assert.equal(active.size, 0);
			assert.equal(shutdown.currentWidget, undefined);
			assert.equal(started.length, startsBeforeShutdown);
			assert.deepEqual(
				shutdown.statusCalls.slice(statusesBeforeShutdown).map((call) => call.value),
				[undefined],
			);

			const print = createHarness({ mode: "print" });
			await execute(print);
			assert.equal(active.size, 0);
		});
	});

	it("isolates cleared callbacks and leaves ten extension generations clean", async () => {
		await withFakeIntervals(async ({ active, started }) => {
			const stale = createHarness();
			await execute(stale);
			const oldTimer = started.at(-1)!;
			const oldWidget = stale.currentWidget;
			await stale.command.handler("off", stale.ctx);
			await stale.command.handler("compact", stale.ctx);
			assert.notStrictEqual(stale.currentWidget, oldWidget);
			assert.equal(active.size, 1);
			const rendersBeforeStaleCallback = stale.renderRequests;
			oldTimer.callback();
			assert.equal(stale.renderRequests, rendersBeforeStaleCallback);
			await stale.emit("session_shutdown", { reason: "reload" });

			const startsBeforeCycles = started.length;
			for (let generation = 0; generation < 10; generation += 1) {
				const harness = createHarness();
				await execute(harness);
				assert.equal(active.size, 1, `generation ${generation} running`);
				await harness.emit("session_shutdown", { reason: "reload" });
				assert.equal(active.size, 0, `generation ${generation} shutdown`);
				assert.equal(harness.currentWidget, undefined);
			}
			assert.equal(started.length - startsBeforeCycles, 10);
			assert.equal(active.size, 0);
		});
	});
});

describe("presentation activity integration", () => {
	it("hides passive and compact tool activity in task mode while keeping expanded runtime activity", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "taskboard-task-mode-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({ taskboard: { activityMode: "task" } }));
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const harness = createHarness();
			await harness.emit("session_start", { reason: "startup" });
			await harness.emit("before_agent_start", { prompt: "implement" });
			assert.equal(harness.currentWidget, undefined);

			await execute(harness);
			await harness.emit("tool_execution_start", { toolCallId: "read-1", toolName: "read", args: { path: "src/a.ts" } });
			const widget = harness.currentWidget as { render(width: number): string[] } | undefined;
			assert.ok(widget);
			assert.doesNotMatch(widget.render(100).join("\n"), /read src\/a\.ts/);
			harness.setToolsExpanded(true);
			assert.match(widget.render(100).join("\n"), /Active: read src\/a\.ts/);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("commands and passive telemetry", () => {
	it("opens a shallow manager that changes view mode and native expansion", async () => {
		const harness = createHarness({
			choices: ["View mode", "full", "Expand live panel", "Done"],
		});
		await execute(harness);
		await harness.command.handler("", harness.ctx);

		assert.equal(harness.entries.at(-1)?.data.viewMode, "full");
		assert.equal(harness.ctx.ui.getToolsExpanded(), true);
		assert.match(harness.selectCalls[0]?.title ?? "", /running 1\/3.*Implement process view/i);
	});

	it("confirms clearing the current task from the manager", async () => {
		const cancelled = createHarness({ choices: ["Clear current task", "Done"], confirmations: [false] });
		await execute(cancelled);
		const before = cancelled.entries.length;
		await cancelled.command.handler("", cancelled.ctx);
		assert.equal(cancelled.entries.length, before);

		const accepted = createHarness({ choices: ["Clear current task"], confirmations: [true] });
		await execute(accepted);
		await accepted.command.handler("", accepted.ctx);
		assert.deepEqual(accepted.entries.at(-1)?.data, { version: 1, viewMode: "compact", cleared: true });
		assert.match(accepted.confirmCalls[0]?.message ?? "", /progress and telemetry/i);
	});

	it("keeps no-argument output textual outside TUI mode", async () => {
		const harness = createHarness({ mode: "print" });
		await harness.command.handler("", harness.ctx);
		assert.match(harness.notifications.at(-1)?.message ?? "", /no active task/i);
		assert.deepEqual(harness.selectCalls, []);
	});

	it("persists mode changes and rejects unknown args", async () => {
		const harness = createHarness();
		await execute(harness);
		await harness.command.handler("full", harness.ctx);
		assert.equal(harness.entries.at(-1)?.data.viewMode, "full");
		await harness.command.handler("off", harness.ctx);
		assert.equal(harness.currentWidget, undefined);
		const count = harness.entries.length;
		await harness.command.handler("unknown", harness.ctx);
		assert.equal(harness.entries.length, count);
		assert.match(harness.notifications.at(-1)?.message ?? "", /Usage:/);
		await harness.command.handler("compact extra", harness.ctx);
		assert.match(harness.notifications.at(-1)?.message ?? "", /Usage:/);
	});

	it("requires confirmation before direct clear", async () => {
		const cancelled = createHarness({ confirmations: [false] });
		await execute(cancelled);
		const before = cancelled.entries.length;
		await cancelled.command.handler("clear", cancelled.ctx);
		assert.equal(cancelled.entries.length, before);
		assert.match(cancelled.confirmCalls[0]?.message ?? "", /progress and telemetry/i);

		const accepted = createHarness({ confirmations: [true] });
		await execute(accepted);
		await accepted.command.handler("clear", accepted.ctx);
		assert.deepEqual(accepted.entries.at(-1)?.data, { version: 1, viewMode: "compact", cleared: true });

		const print = createHarness({ mode: "print" });
		await execute(print);
		const printBefore = print.entries.length;
		await print.command.handler("clear", print.ctx);
		assert.equal(print.entries.length, printBefore);
		assert.match(print.notifications.at(-1)?.message ?? "", /requires TUI confirmation/i);
	});

	it("follows native tool expansion and records task-local assistant usage", async () => {
		const harness = createHarness();
		await execute(harness);
		assert.doesNotMatch(harness.currentWidget.render(110).join("\n"), /Tasks|Runtime/);

		harness.setToolsExpanded(true);
		assert.match(harness.currentWidget.render(110).join("\n"), /Taskboard.*Tasks.*Runtime/s);

		await harness.emit("message_end", {
			message: {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.6-sol",
				usage: {
					input: 30_000,
					output: 1_500,
					cacheRead: 22_000,
					cacheWrite: 400,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		});
		const expanded = harness.currentWidget.render(110).join("\n");
		assert.match(expanded, /openai\/gpt-5\.6-sol/);
		assert.match(expanded, /↑30k.*↓1\.5k.*R22k/);

		await harness.emit("agent_settled");
		assert.equal(harness.entries.at(-1)?.data.telemetry.turns, 1);
	});

	it("updates the mounted Widget for passive message and tool events", async () => {
		const harness = createHarness();
		await harness.emit("before_agent_start", { prompt: "simple request" });
		assert.match(harness.currentWidget.render(80).join("\n"), /Starting/);
		const before = harness.renderRequests;
		await harness.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "private" } });
		await harness.emit("tool_execution_start", { toolCallId: "read-1", toolName: "read", args: { path: "a.ts" } });
		assert.ok(harness.renderRequests > before);
		assert.match(harness.currentWidget.render(100).join("\n"), /Running 1 tool/);
		await harness.emit("tool_execution_end", { toolCallId: "read-1", toolName: "read", isError: false, result: { secret: true } });
		assert.match(harness.currentWidget.render(100).join("\n"), /Latest tool finished/);
	});

	it("pauses running telemetry and cleans UI state on shutdown", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("before_agent_start", { prompt: "task" });
		await execute(harness);
		await harness.emit("session_shutdown", { reason: "reload" });
		const saved = harness.entries.at(-1)?.data;
		assert.equal(saved.snapshot.status, "waiting");
		assert.equal(saved.telemetry.steps[1].activeSince, undefined);
		assert.equal(harness.widgetCalls.at(-1)?.content, undefined);
		assert.equal(harness.hiddenLabels.at(-1), undefined);
	});
});
