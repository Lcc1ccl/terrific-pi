import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fastExtension, { injectPriority } from "../extensions/fast.ts";

function createExtensionHarness(entries: Array<{ type: string; customType?: string; data?: unknown }> = []) {
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const appended: Array<{ type: string; customType: string; data: unknown }> = [];
	const statuses = new Map<string, string | undefined>();

	fastExtension({
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry: (customType: string, data: unknown) => {
			const entry = { type: "custom", customType, data };
			entries.push(entry);
			appended.push(entry);
		},
	} as never);

	const ctx = {
		ui: {
			notify() {},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
		},
		sessionManager: { getBranch: () => entries },
		model: { api: "openai-responses" },
	};

	return { appended, commands, ctx, handlers, statuses };
}

describe("fast session state", () => {
	it("restores the latest enabled state from the current branch", async () => {
		const { ctx, handlers, statuses } = createExtensionHarness([
			{ type: "custom", customType: "fast-state", data: { enabled: true } },
		]);

		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);

		assert.equal(statuses.get("fast"), "");
	});

	it("persists explicit toggle changes as session entries", async () => {
		const { appended, commands, ctx } = createExtensionHarness();

		await commands.get("fast")!.handler("on", ctx);
		await commands.get("fast")!.handler("off", ctx);

		assert.deepEqual(appended.map((entry) => entry.data), [{ enabled: true }, { enabled: false }]);
	});
});

describe("injectPriority", () => {
	it("sets service_tier=priority on plain objects", () => {
		const payload = { model: "gpt-5.2", stream: true, store: false };
		const next = injectPriority(payload);
		assert.equal(next, payload);
		assert.equal((payload as { service_tier?: string }).service_tier, "priority");
	});

	it("overwrites an existing service_tier", () => {
		const payload = { service_tier: "default" };
		injectPriority(payload);
		assert.equal(payload.service_tier, "priority");
	});

	it("ignores non-objects", () => {
		assert.equal(injectPriority(null), undefined);
		assert.equal(injectPriority(undefined), undefined);
		assert.equal(injectPriority("x"), undefined);
		assert.equal(injectPriority([1]), undefined);
	});
});
