import assert from "node:assert/strict";
import { describe, it } from "node:test";

import processView from "../extensions/process-view.ts";
import { createPersistedState, normalizeProcessUpdate, syncProcessTelemetry } from "../lib/state.ts";
import {
	PROCESS_CONTEXT_TYPE,
	PROCESS_ENTRY_TYPE,
	PROCESS_STATUS_KEY,
	PROCESS_WIDGET_KEY,
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
}

function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const entries: any[] = [...(options.branch ?? [])];
	const notifications: Array<{ message: string; type?: string }> = [];
	const hiddenLabels: Array<string | undefined> = [];
	const widgetCalls: Array<{ key: string; content: unknown }> = [];
	const statusCalls: Array<{ key: string; value: string | undefined }> = [];
	const shortcuts: unknown[] = [];
	let tool: any;
	let command: any;
	let failAppend = false;
	let currentWidget: any;
	let renderRequests = 0;
	let toolsExpanded = options.toolsExpanded ?? false;

	const ui = {
		setWidget(key: string, content: unknown) {
			if (options.throwWidget) throw new Error("widget unavailable");
			widgetCalls.push({ key, content });
			if (typeof content === "function") {
				currentWidget = content({ requestRender: () => { renderRequests += 1; } }, theme);
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
			if (name === "process") command = value;
		},
		registerShortcut(value: unknown) {
			shortcuts.push(value);
		},
		appendEntry(customType: string, data: unknown) {
			if (failAppend) throw new Error("session write failed");
			entries.push({ type: "custom", customType, data });
		},
	};
	processView(pi as never);

	return {
		ctx,
		entries,
		notifications,
		hiddenLabels,
		widgetCalls,
		statusCalls,
		shortcuts,
		get tool() { return tool; },
		get command() { return command; },
		get currentWidget() { return currentWidget; },
		get renderRequests() { return renderRequests; },
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
	return [...entries].reverse().find((entry) => entry.customType === PROCESS_ENTRY_TYPE)?.data.snapshot;
}

describe("process-view registration and tool", () => {
	it("registers one sequential self-shell tool, one command, and no shortcut", () => {
		const harness = createHarness();
		assert.equal(harness.tool.name, "process_update");
		assert.equal(harness.tool.executionMode, "sequential");
		assert.equal(harness.tool.renderShell, "self");
		assert.ok(harness.tool.promptGuidelines.every((line: string) => line.includes("process_update")));
		assert.ok(harness.command);
		assert.deepEqual(harness.shortcuts, []);
	});

	it("persists normalized details before committing UI state", async () => {
		const harness = createHarness();
		const result = await execute(harness);
		assert.match(result.content[0].text, /Process state updated: 1\/3 running/);
		const { telemetry, ...detailsSnapshot } = result.details;
		assert.deepEqual(harness.entries[0].data.snapshot, detailsSnapshot);
		assert.deepEqual(harness.entries[0].data.telemetry, telemetry);
		assert.equal(harness.entries[0].customType, PROCESS_ENTRY_TYPE);
		assert.equal(harness.widgetCalls[0]?.key, PROCESS_WIDGET_KEY);
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
		assert.match(harness.notifications.at(-1)?.message ?? "", /no active task/i);
	});

	it("keeps in-memory state unchanged when appendEntry fails", async () => {
		const harness = createHarness();
		harness.setFailAppend(true);
		await assert.rejects(() => execute(harness), /session write failed/);
		harness.setFailAppend(false);
		await harness.command.handler("", harness.ctx);
		assert.match(harness.notifications.at(-1)?.message ?? "", /no active task/i);
		assert.deepEqual(harness.entries, []);
	});

	it("returns a tool result even when Widget rendering fails", async () => {
		const harness = createHarness({ throwWidget: true });
		const result = await execute(harness);
		assert.equal(result.details.title, "Implement process view");
		assert.equal(harness.entries.length, 1);
		assert.match(harness.notifications[0]?.message ?? "", /Process View UI/i);
	});

	it("uses an empty call renderer and stable collapsed/expanded result renderers", async () => {
		const harness = createHarness();
		const result = await execute(harness, completedInput());
		assert.deepEqual(harness.tool.renderCall(runningInput(), theme, {}).render(100), []);
		const collapsed = harness.tool.renderResult(result, { expanded: false }, theme, { isError: false }).render(120);
		const expanded = harness.tool.renderResult(result, { expanded: true }, theme, { isError: false }).render(120);
		assert.match(collapsed.join("\n"), /Process done 3\/3/);
		assert.match(expanded.join("\n"), /Verification: All checks passed/);
		const error = harness.tool.renderResult(
			{ content: [{ type: "text", text: "Invalid update" }] },
			{ expanded: false },
			theme,
			{ isError: true },
		).render(120);
		assert.deepEqual(error.map((line: string) => line.trimEnd()), ["Invalid update"]);
	});
});

describe("request, branch, and context lifecycle", () => {
	it("fails closed by persisting a tombstone for corrupt branch state", async () => {
		const harness = createHarness({
			branch: [{
				type: "custom",
				customType: PROCESS_ENTRY_TYPE,
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
		const harness = createHarness({ branch: [{ type: "custom", customType: PROCESS_ENTRY_TYPE, data: stored }] });
		await harness.emit("session_start", { reason: "resume" });
		assert.equal(harness.widgetCalls[0]?.key, PROCESS_WIDGET_KEY);
		assert.match(harness.hiddenLabels[0] ?? "", /Reasoning hidden.*to inspect/);

		const print = createHarness({ mode: "print", branch: [{ type: "custom", customType: PROCESS_ENTRY_TYPE, data: stored }] });
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
		const harness = createHarness({ branch: [{ type: "custom", customType: PROCESS_ENTRY_TYPE, data: stored }] });
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
		assert.equal(first.messages[1].customType, PROCESS_CONTEXT_TYPE);
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
			customType: PROCESS_ENTRY_TYPE,
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
		assert.equal(first.messages[0].customType, PROCESS_CONTEXT_TYPE);
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
		assert.deepEqual(harness.statusCalls.at(-1), { key: PROCESS_STATUS_KEY, value: "waiting" });

		await execute(harness, { ...runningInput(), status: "blocked", blocker: "Need decision" });
		assert.deepEqual(harness.statusCalls.at(-1), { key: PROCESS_STATUS_KEY, value: "blocked" });

		await execute(harness, completedInput());
		assert.deepEqual(harness.statusCalls.at(-1), { key: PROCESS_STATUS_KEY, value: undefined });

		await harness.emit("session_shutdown", { reason: "quit" });
		assert.deepEqual(harness.statusCalls.at(-1), { key: PROCESS_STATUS_KEY, value: undefined });
	});
});

describe("commands and passive telemetry", () => {
	it("persists mode changes, rejects unknown args, and clears with a tombstone", async () => {
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
		await harness.command.handler("clear", harness.ctx);
		assert.deepEqual(harness.entries.at(-1)?.data, { version: 1, viewMode: "off", cleared: true });
	});

	it("follows native tool expansion and records task-local assistant usage", async () => {
		const harness = createHarness();
		await execute(harness);
		assert.doesNotMatch(harness.currentWidget.render(110).join("\n"), /Tasks|Runtime/);

		harness.setToolsExpanded(true);
		assert.match(harness.currentWidget.render(110).join("\n"), /Process View.*Tasks.*Runtime/s);

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
		assert.match(harness.currentWidget.render(100).join("\n"), /read a\.ts/);
		await harness.emit("tool_execution_end", { toolCallId: "read-1", toolName: "read", isError: false, result: { secret: true } });
		assert.match(harness.currentWidget.render(100).join("\n"), /✓ read a\.ts/);
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
