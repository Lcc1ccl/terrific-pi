import assert from "node:assert/strict";
import { describe, test } from "node:test";

import pilot from "../extensions/pilot.ts";
import { PILOT_ACTIVATION_ENTRY_TYPE } from "../lib/activation.ts";

class Events {
	private readonly handlers = new Map<string, Array<(value: unknown) => void>>();
	readonly emitted: string[] = [];

	on(name: string, handler: (value: unknown) => void): () => void {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
		return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
	}

	emit(name: string, value: unknown): void {
		this.emitted.push(name);
		for (const handler of this.handlers.get(name) ?? []) handler(value);
	}
}

function createHarness(branchEntries: unknown[] = []) {
	const events = new Events();
	const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
	const hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	let branch = [...branchEntries];
	const notifications: string[] = [];
	const statuses = new Map<string, string | undefined>();

	pilot({
		events,
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
		appendEntry(customType: string, data: unknown) {
			const entry = { type: "custom", customType, data };
			entries.push(entry);
			branch.push(entry);
		},
		getActiveTools() { return ["read", "grep", "find", "ls", "bash", "edit", "write", "aux_summarize"]; },
		setActiveTools() {},
	} as never);

	const ctx = {
		cwd: "/workspace",
		hasUI: false,
		mode: "print",
		isIdle: () => true,
		isProjectTrusted: () => true,
		ui: {
			notify(message: string) { notifications.push(message); },
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
		},
		sessionManager: { getBranch: () => branch },
	};

	return {
		commands,
		ctx,
		entries,
		hooks,
		notifications,
		statuses,
		getRouterRequests: () => events.emitted.filter((name) => name === "terrific-pi:auxiliary:pilot-router:request-v1").length,
		setBranch(next: unknown[]) { branch = [...next]; },
	};
}

async function emit(harness: ReturnType<typeof createHarness>, event: string, value: unknown) {
	let result: unknown;
	for (const handler of harness.hooks.get(event) ?? []) result = await handler(value, harness.ctx);
	return result;
}

describe("Pilot manual Copilot activation", () => {
	test("stays inactive by default and does not register the standalone mode command", async () => {
		const harness = createHarness();
		await emit(harness, "session_start", { reason: "startup" });

		assert.equal(harness.commands.has("mode"), false);
		assert.equal(harness.statuses.get("pilot"), undefined);
		assert.deepEqual(await emit(harness, "input", { source: "interactive", text: "Change the code" }), { action: "continue" });
		assert.equal(harness.getRouterRequests(), 0);
	});

	test("handles a goal only after explicit manual activation", async () => {
		const harness = createHarness();
		await emit(harness, "session_start", { reason: "startup" });
		await harness.commands.get("pilot")!.handler("", harness.ctx);

		assert.equal(harness.statuses.get("pilot"), "manual");
		assert.deepEqual(harness.entries.at(-1), {
			type: "custom",
			customType: PILOT_ACTIVATION_ENTRY_TYPE,
			data: { version: 1, modePolicy: "edit", manualPilotActive: true },
		});
		assert.deepEqual(await emit(harness, "input", { source: "interactive", text: "Change the code" }), { action: "handled" });
		assert.equal(harness.getRouterRequests(), 0);
	});

	test("blocks parent mutation tools while Pilot is active", async () => {
		const harness = createHarness();
		await emit(harness, "session_start", { reason: "startup" });
		assert.equal(await emit(harness, "tool_call", { toolName: "write", input: {} }), undefined);

		await harness.commands.get("pilot")!.handler("", harness.ctx);
		for (const toolName of ["bash", "edit", "write", "git_finalize"]) {
			assert.deepEqual(await emit(harness, "tool_call", { toolName, input: {} }), {
				block: true,
				reason: "Pilot is active; project mutations require the authorized Worker.",
			});
		}
		assert.equal(await emit(harness, "tool_call", { toolName: "read", input: {} }), undefined);
	});

	test("does not restore legacy AUTO entries as active Copilot state", async () => {
		const harness = createHarness([{
			type: "custom",
			customType: PILOT_ACTIVATION_ENTRY_TYPE,
			data: { version: 1, modePolicy: "auto", manualPilotActive: false },
		}]);
		await emit(harness, "session_start", { reason: "startup" });

		assert.equal(harness.statuses.get("pilot"), undefined);
		assert.deepEqual(await emit(harness, "input", { source: "interactive", text: "Explain this module" }), { action: "continue" });
		assert.equal(harness.getRouterRequests(), 0);
	});

	test("restores only explicit manual activation after tree navigation", async () => {
		const harness = createHarness();
		await emit(harness, "session_start", { reason: "startup" });
		harness.setBranch([{
			type: "custom",
			customType: PILOT_ACTIVATION_ENTRY_TYPE,
			data: { version: 1, modePolicy: "edit", manualPilotActive: true },
		}]);
		await emit(harness, "session_tree", { newLeafId: "manual", oldLeafId: "inactive" });

		assert.equal(harness.statuses.get("pilot"), "manual");
		assert.deepEqual(await emit(harness, "input", { source: "interactive", text: "Change the code" }), { action: "handled" });
	});
});
