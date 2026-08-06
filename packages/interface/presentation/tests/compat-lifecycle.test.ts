import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	createBashToolDefinition,
	initTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { createToolRenderController } from "../lib/compat/tool-render.ts";
import { installPresentationCompatibility } from "../lib/compat/index.ts";

function runningInstance() {
	return {
		toolCallId: "bash-1",
		toolName: "bash",
		args: {},
		cwd: "/workspace",
		executionStarted: true,
		isPartial: true,
		expanded: false,
		ui: { requestRender() {} },
	};
}

test("production patch allowlist contains exactly the two native render targets", () => {
	const root = join(import.meta.dirname, "..");
	const files = [
		...readdirSync(join(root, "extensions"), { recursive: true }).filter((value) => String(value).endsWith(".ts")).map((value) => join(root, "extensions", String(value))),
		...readdirSync(join(root, "lib"), { recursive: true }).filter((value) => String(value).endsWith(".ts")).map((value) => join(root, "lib", String(value))),
	];
	const calls: string[] = [];
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		if (file.endsWith("prototype-patch.ts")) continue;
		for (const match of source.matchAll(/patchPrototypeMethod\(\s*([A-Za-z]+)\.prototype,\s*"([^"]+)"/g)) {
			calls.push(`${match[1]}.prototype.${match[2]}`);
		}
	}
	assert.deepEqual(calls.sort(), [
		"ToolExecutionComponent.prototype.render",
		"UserMessageComponent.prototype.render",
	]);
});

test("ten compatibility generations unload unordered and reverse without patch or timer leaks", () => {
	initTheme("dark", false);
	const originalUser = UserMessageComponent.prototype.render;
	const originalTool = ToolExecutionComponent.prototype.render;
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const active = new Set<object>();
	globalThis.setInterval = ((callback: () => void) => {
		const handle = { callback, unref() {} };
		active.add(handle);
		return handle;
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = ((handle: unknown) => { active.delete(handle as object); }) as typeof clearInterval;
	const handles: Array<ReturnType<typeof installPresentationCompatibility>> = [];
	try {
		for (let generation = 0; generation < 10; generation += 1) {
			handles.push(installPresentationCompatibility({
				isUserMessageBoxEnabled: () => false,
				isCompactToolsEnabled: () => true,
				getTheme: () => undefined,
				now: () => 1_000,
			}));
		}
		assert.notEqual(UserMessageComponent.prototype.render, originalUser);
		assert.notEqual(ToolExecutionComponent.prototype.render, originalTool);
		const component = new ToolExecutionComponent(
			"bash",
			"generation-bash",
			{ command: "printf ok" },
			{},
			createBashToolDefinition("/workspace"),
			{ requestRender() {} } as never,
			"/workspace",
		);
		component.markExecutionStarted();
		component.render(80);
		assert.equal(active.size, 1);

		for (const index of [2, 5, 0, 7]) handles[index]?.uninstall();
		assert.equal(active.size, 1, "stale owners leave the current timer intact");
		handles[9]?.uninstall();
		assert.equal(active.size, 0, "the live owner disposes its timer");
		component.render(80);
		assert.equal(active.size, 1, "the previous owner starts exactly one timer");

		for (const index of [8, 6, 4, 3, 1]) handles[index]?.uninstall();
		assert.equal(active.size, 0);
		assert.equal(UserMessageComponent.prototype.render, originalUser);
		assert.equal(ToolExecutionComponent.prototype.render, originalTool);
	} finally {
		for (const handle of handles) handle.uninstall();
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	}
});

test("old nonterminal mounted states cannot restart or retain the next-turn timer", () => {
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const active = new Map<object, () => void>();
	globalThis.setInterval = ((callback: () => void) => {
		const handle = { unref() {} };
		active.set(handle, callback);
		return handle;
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = ((handle: unknown) => { active.delete(handle as object); }) as typeof clearInterval;
	let oldRedraws = 0;
	let nextRedraws = 0;
	const old = {
		...runningInstance(),
		toolCallId: "old-bash",
		ui: { requestRender() { oldRedraws += 1; } },
	};
	const next = {
		...runningInstance(),
		toolCallId: "next-bash",
		ui: { requestRender() { nextRedraws += 1; } },
	};
	const controller = createToolRenderController({ isEnabled: () => true, getTheme: () => undefined, now: () => 1_000 });
	try {
		controller.start({ toolCallId: "old-bash", toolName: "bash", args: {}, cwd: "/workspace" });
		controller.render(old, 80, () => ["native old"]);
		assert.equal(active.size, 1);
		controller.boundary();
		assert.equal(active.size, 0);

		controller.render(old, 80, () => ["native old"]);
		assert.equal(active.size, 0, "an old-turn render must not restart the timer");

		controller.start({ toolCallId: "next-bash", toolName: "bash", args: {}, cwd: "/workspace" });
		controller.render(next, 80, () => ["native next"]);
		assert.equal(active.size, 1, "same-turn running tool starts one timer");
		active.values().next().value?.();
		assert.equal(oldRedraws, 0, "timer does not redraw stale components");
		assert.equal(nextRedraws, 1, "timer still redraws the current running component");

		controller.end({ toolCallId: "next-bash", toolName: "bash", result: { content: [] }, isError: false });
		assert.equal(active.size, 0, "ending the current tool leaves no timer retained by stale state");
	} finally {
		controller.dispose();
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	}
});

test("the single running timer exists only for a mounted running tool and clears on lifecycle boundaries", () => {
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const active = new Set<object>();
	let created = 0;
	globalThis.setInterval = ((callback: () => void, _ms?: number) => {
		const handle = { callback, unref() {} };
		active.add(handle);
		created += 1;
		return handle;
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = ((handle: unknown) => { active.delete(handle as object); }) as typeof clearInterval;
	try {
		const controller = createToolRenderController({ isEnabled: () => true, getTheme: () => undefined, now: () => 1_000 });
		controller.start({ toolCallId: "bash-1", toolName: "bash", args: {}, cwd: "/workspace" });
		assert.equal(active.size, 0, "unmounted running state has no timer");
		controller.render(runningInstance(), 80, () => ["native"]);
		assert.equal(active.size, 1);
		assert.equal(created, 1);
		controller.render(runningInstance(), 80, () => ["native"]);
		assert.equal(created, 1, "render reuses the one timer");
		controller.boundary();
		assert.equal(active.size, 0, "idle boundary clears timer");

		controller.render(runningInstance(), 80, () => ["native"]);
		assert.equal(active.size, 0, "old-turn render stays timer-free after boundary");
		controller.end({ toolCallId: "bash-1", toolName: "bash", result: { content: [] }, isError: false });
		assert.equal(active.size, 0, "ending stale state leaves timer clear");

		controller.start({ toolCallId: "bash-2", toolName: "bash", args: {}, cwd: "/workspace" });
		controller.render({ ...runningInstance(), toolCallId: "bash-2" }, 80, () => ["native"]);
		assert.equal(active.size, 1);
		controller.hydrate([], "/workspace");
		assert.equal(active.size, 0, "hydration clears timer");

		controller.start({ toolCallId: "bash-3", toolName: "bash", args: {}, cwd: "/workspace" });
		controller.render({ ...runningInstance(), toolCallId: "bash-3" }, 80, () => ["native"]);
		assert.equal(active.size, 1);
		controller.dispose();
		assert.equal(active.size, 0, "dispose/shutdown clears timer");
	} finally {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	}
});
