import assert from "node:assert/strict";
import { describe, test } from "node:test";

import pilot from "../extensions/pilot.ts";
import {
	PILOT_ROUTER_CANCEL_EVENT,
	PILOT_ROUTER_REQUEST_EVENT,
	PILOT_ROUTER_RESPONSE_EVENT,
	PILOT_ROUTER_STARTED_EVENT,
} from "../lib/aux-router.ts";
import { PILOT_ACTIVATION_ENTRY_TYPE } from "../lib/activation.ts";

class Events {
	private readonly handlers = new Map<string, Array<(value: unknown) => void>>();

	on(name: string, handler: (value: unknown) => void): () => void {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
		return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
	}

	emit(name: string, value: unknown): void {
		for (const handler of this.handlers.get(name) ?? []) handler(value);
	}
}

function createHarness(decision: unknown) {
	const events = new Events();
	const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
	const hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	let branch: unknown[] = entries;
	const notifications: string[] = [];
	const statuses = new Map<string, string | undefined>();
	let tools = ["read", "grep", "find", "ls", "bash", "edit", "write", "aux_summarize"];
	let requests = 0;
	let nextToolSetError: Error | undefined;

	events.on(PILOT_ROUTER_REQUEST_EVENT, (value) => {
		const request = value as { requestId: string };
		requests += 1;
		events.emit(PILOT_ROUTER_STARTED_EVENT, { version: 1, requestId: request.requestId });
		if (decision === undefined) return;
		events.emit(PILOT_ROUTER_RESPONSE_EVENT, {
			version: 1,
			requestId: request.requestId,
			status: "completed",
			decision,
		});
	});

	pilot({
		events,
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
		appendEntry(customType: string, data: unknown) {
			const entry = { type: "custom", customType, data };
			entries.push(entry);
			if (branch !== entries) branch.push(entry);
		},
		getActiveTools() { return [...tools]; },
		setActiveTools(next: string[]) {
			if (nextToolSetError) {
				const error = nextToolSetError;
				nextToolSetError = undefined;
				throw error;
			}
			tools = [...next];
		},
	} as never);

	const ctx = {
		cwd: "/workspace",
		hasUI: false,
		mode: "print",
		isIdle: () => true,
		isProjectTrusted: () => false,
		ui: {
			notify(message: string) { notifications.push(message); },
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
		},
		sessionManager: { getBranch: () => branch },
	};

	return {
		commands,
		ctx,
		events,
		entries,
		hooks,
		notifications,
		statuses,
		getRequests: () => requests,
		getTools: () => tools,
		failNextToolSet: () => { nextToolSetError = new Error("tool mutation failed"); },
		setBranch: (next: unknown[]) => { branch = next; },
	};
}

async function emit(harness: ReturnType<typeof createHarness>, event: string, value: unknown) {
	let result: unknown;
	for (const handler of harness.hooks.get(event) ?? []) result = await handler(value, harness.ctx);
	return result;
}

describe("Pilot input routing spike", () => {
	test("keeps locked PLAN direct until manual activation, then handles the prompt without calling the router", async () => {
		const harness = createHarness({ route: "ask", confidence: 0.9, reasons: [], riskFlags: [] });
		await emit(harness, "session_start", { reason: "startup" });
		await harness.commands.get("mode")!.handler("plan", harness.ctx);

		assert.deepEqual(await emit(harness, "input", { source: "interactive", text: "plan this" }), { action: "continue" });
		assert.equal(harness.getRequests(), 0);
			const directPrompt = await emit(harness, "before_agent_start", { systemPrompt: "base" }) as { systemPrompt: string };
		assert.match(directPrompt.systemPrompt, /PLAN mode/);

		await harness.commands.get("pilot")!.handler("", harness.ctx);
		assert.deepEqual(await emit(harness, "input", { source: "interactive", text: "plan this" }), { action: "handled" });
		assert.equal(harness.getRequests(), 0);
		assert.equal(harness.statuses.get("pilot"), "manual");
		assert.deepEqual(harness.entries.map((entry) => entry.customType), [
			"terrific-pi:pilot:activation-v1",
			"terrific-pi:pilot:activation-v1",
		]);
	});

	test("removes mutation tools when manual Pilot activates from direct EDIT", async () => {
		const harness = createHarness({ route: "ask", confidence: 0.9, reasons: [], riskFlags: [] });
		await emit(harness, "session_start", { reason: "startup" });
		await harness.commands.get("mode")!.handler("edit", harness.ctx);
		assert.ok(harness.getTools().includes("edit"));
		await harness.commands.get("pilot")!.handler("", harness.ctx);
		assert.deepEqual(harness.getTools(), ["read", "grep", "find", "ls", "aux_summarize"]);
		assert.deepEqual(await emit(harness, "input", { source: "interactive", text: "Change the code" }), { action: "handled" });
		assert.equal(harness.getRequests(), 0);
	});

	test("routes AUTO ASK through Auxiliary once and lets only the main session continue read-only", async () => {
		const harness = createHarness({ route: "ask", confidence: 0.91, reasons: ["question"], riskFlags: [] });
		await emit(harness, "session_start", { reason: "startup" });

		assert.deepEqual(await emit(harness, "input", { source: "interactive", text: "Explain this module" }), { action: "continue" });
		assert.equal(harness.getRequests(), 1);
		assert.deepEqual(harness.getTools(), ["read", "grep", "find", "ls", "aux_summarize"]);
		assert.equal(harness.statuses.get("mode"), "AUTO->ASK");
		const prompt = await emit(harness, "before_agent_start", { systemPrompt: "base" }) as { systemPrompt: string };
		assert.match(prompt.systemPrompt, /ASK mode/);
	});

	test("handles AUTO PLAN, EDIT, and invalid decisions before the main session can start", async () => {
		for (const decision of [
			{ route: "plan", confidence: 0.9, reasons: [], riskFlags: [] },
			{ route: "edit", confidence: 0.9, reasons: [], riskFlags: [] },
			{ route: "edit", confidence: "invalid", reasons: [], riskFlags: [] },
		]) {
			const harness = createHarness(decision);
			await emit(harness, "session_start", { reason: "startup" });
			assert.deepEqual(await emit(harness, "input", { source: "interactive", text: "Change the code" }), { action: "handled" });
			assert.equal(harness.getRequests(), 1);
			assert.deepEqual(harness.getTools(), ["read", "grep", "find", "ls", "aux_summarize"]);
			assert.equal(harness.entries.some((entry) => /bundle|receipt/.test(entry.customType)), false);
		}
	});

	test("cancels a pending AUTO route without falling back to PLAN", async () => {
		const harness = createHarness(undefined);
		let cancelled = false;
		harness.events.on(PILOT_ROUTER_CANCEL_EVENT, () => { cancelled = true; });
		await emit(harness, "session_start", { reason: "startup" });
		const pending = emit(harness, "input", { source: "interactive", text: "Change the code" });
		await Promise.resolve();
		await harness.commands.get("pilot")!.handler("cancel", harness.ctx);
		const result = await pending;
		assert.deepEqual(result, { action: "handled" });
		assert.equal(harness.statuses.get("mode"), "AUTO");
		assert.equal(harness.getRequests(), 1);
		assert.equal(cancelled, true);
	});

	test("keeps the current mode when applying a new tool policy fails", async () => {
		const harness = createHarness({ route: "ask", confidence: 0.9, reasons: [], riskFlags: [] });
		await emit(harness, "session_start", { reason: "startup" });
		harness.failNextToolSet();
		await harness.commands.get("mode")!.handler("plan", harness.ctx);
		await harness.commands.get("pilot")!.handler("status", harness.ctx);
		assert.match(harness.notifications.at(-1) ?? "", /mode AUTO/);
		assert.deepEqual(harness.entries, []);
	});

	test("fails closed when the session-start tool policy cannot be applied", async () => {
		const harness = createHarness({ route: "ask", confidence: 0.9, reasons: [], riskFlags: [] });
		harness.failNextToolSet();
		await emit(harness, "session_start", { reason: "startup" });

		assert.deepEqual(harness.getTools(), ["read", "grep", "find", "ls", "bash", "edit", "write", "aux_summarize"]);
		assert.equal(harness.statuses.get("mode"), undefined);
		assert.match(harness.notifications.at(-1) ?? "", /tool policy failed/i);
		assert.deepEqual(await emit(harness, "input", { source: "interactive", text: "Change the code" }), { action: "continue" });
		assert.equal(harness.getRequests(), 0);
	});

	test("restores activation and tool policy after tree navigation", async () => {
		const harness = createHarness({ route: "ask", confidence: 0.9, reasons: [], riskFlags: [] });
		await emit(harness, "session_start", { reason: "startup" });
		await harness.commands.get("mode")!.handler("edit", harness.ctx);
		await harness.commands.get("pilot")!.handler("", harness.ctx);

		harness.setBranch([{
			type: "custom",
			customType: PILOT_ACTIVATION_ENTRY_TYPE,
			data: { version: 1, modePolicy: "plan", manualPilotActive: false },
		}]);
		await emit(harness, "session_tree", { newLeafId: "plan", oldLeafId: "edit" });

		assert.deepEqual(harness.getTools(), ["read", "grep", "find", "ls", "aux_summarize"]);
		assert.equal(harness.statuses.get("mode"), "PLAN");
		assert.equal(harness.statuses.get("pilot"), undefined);
		const prompt = await emit(harness, "before_agent_start", { systemPrompt: "base" }) as { systemPrompt: string };
		assert.match(prompt.systemPrompt, /PLAN mode/);
	});
});
