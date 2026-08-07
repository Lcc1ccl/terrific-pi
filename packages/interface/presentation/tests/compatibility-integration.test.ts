import assert from "node:assert/strict";
import test from "node:test";

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

import presentation from "../extensions/presentation.ts";

function createHarness() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const tools: string[] = [];
	const ctx = {
		cwd: "/workspace/project",
		mode: "tui",
		hasUI: true,
		ui: {
			theme: {
				fg(_color: string, text: string) { return text; },
				bg(_color: string, text: string) { return text; },
				bold(text: string) { return text; },
			},
			notify() {},
		},
		sessionManager: {
			getBranch() { return []; },
			getLeafId() { return "request-1"; },
		},
	};
	const pi = {
		on(name: string, handler: (event: unknown, eventCtx: unknown) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: { on() { return () => {}; } },
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		registerCommand() {},
		registerEntryRenderer() {},
		appendEntry() {},
		getCommands() { return []; },
		getThinkingLevel() { return "off"; },
		exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
	};
	presentation(pi as never);
	return {
		tools,
		async emit(name: string, event: unknown = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

test("presentation patches display only and restores all three prototypes on shutdown", async () => {
	const originalAssistantRender = AssistantMessageComponent.prototype.render;
	const originalUserRender = UserMessageComponent.prototype.render;
	const originalToolRender = ToolExecutionComponent.prototype.render;
	const harness = createHarness();
	try {
		assert.deepEqual(harness.tools, [], "presentation must not own built-in execution tools");
		assert.notEqual(AssistantMessageComponent.prototype.render, originalAssistantRender);
		assert.notEqual(UserMessageComponent.prototype.render, originalUserRender);
		assert.notEqual(ToolExecutionComponent.prototype.render, originalToolRender);
	} finally {
		await harness.emit("session_shutdown", { reason: "quit" });
	}
	assert.equal(AssistantMessageComponent.prototype.render, originalAssistantRender);
	assert.equal(UserMessageComponent.prototype.render, originalUserRender);
	assert.equal(ToolExecutionComponent.prototype.render, originalToolRender);
});
