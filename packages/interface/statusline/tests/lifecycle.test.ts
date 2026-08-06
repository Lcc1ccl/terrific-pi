import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import statusline from "../extensions/statusline.ts";

const cleanup: string[] = [];
afterEach(() => {
	delete process.env.PI_STATUSLINE_CONFIG;
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(raw: unknown): { cwd: string; path: string } {
	const cwd = mkdtempSync(join(tmpdir(), "statusline-lifecycle-"));
	cleanup.push(cwd);
	const path = join(cwd, "statusline.json");
	writeFileSync(path, `${JSON.stringify(raw)}\n`);
	process.env.PI_STATUSLINE_CONFIG = path;
	return { cwd, path };
}

function harness(exec: (...args: any[]) => Promise<any>) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const busHandlers = new Map<string, Array<(value: any) => void>>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	let footerFactory: ((tui: any, theme: any, data: any) => any) | undefined;
	let renders = 0;
	const pi = {
		events: {
			on(name: string, handler: (value: any) => void) {
				busHandlers.set(name, [...(busHandlers.get(name) ?? []), handler]);
				return () => busHandlers.set(name, (busHandlers.get(name) ?? []).filter((item) => item !== handler));
			},
		},
		on(name: string, handler: (event: any, ctx: any) => any) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		getThinkingLevel: () => "high",
		exec,
	};
	const makeCtx = (
		cwd: string,
		mode = "tui",
		customChoices: Array<string | { value: string; delay: number }> = [],
	) => ({
		cwd,
		mode,
		hasUI: mode === "tui",
		model: { id: "model", reasoning: false },
		signal: undefined,
		getContextUsage: () => undefined,
		sessionManager: {
			getBranch: () => [],
			getSessionName: () => undefined,
		},
		modelRegistry: {
			isUsingOAuth: () => false,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "disabled" }),
		},
		ui: {
			notify: (text: string) => notifications.push(text),
			setFooter(factory: typeof footerFactory) { footerFactory = factory; },
			async custom() {
				const choice = customChoices.shift();
				if (typeof choice === "object") {
					await new Promise((resolve) => setTimeout(resolve, choice.delay));
					return choice.value;
				}
				return choice;
			},
		},
	});
	statusline(pi as never);
	return {
		commands,
		handlers,
		notifications,
		makeCtx,
		async emit(name: string, event: any, ctx: any) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		emitBus(name: string, value: any) {
			for (const handler of busHandlers.get(name) ?? []) handler(value);
		},
		mountFooter(statuses: ReadonlyMap<string, string> = new Map()) {
			return footerFactory?.(
				{ requestRender: () => { renders += 1; } },
				{ fg: (_color: string, text: string) => text },
				{
					onBranchChange: () => () => {},
					getExtensionStatuses: () => statuses,
					getGitBranch: () => null,
				},
			);
		},
		get renders() { return renders; },
	};
}

function assistantMessage(stopReason = "stop") {
	return {
		role: "assistant",
		stopReason,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00006 },
		},
	};
}

async function settledRun(app: ReturnType<typeof harness>, ctx: any): Promise<void> {
	const message = assistantMessage();
	await app.emit("agent_start", { type: "agent_start" }, ctx);
	await app.emit("turn_start", { type: "turn_start" }, ctx);
	await app.emit("message_start", { type: "message_start", message }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 2));
	await app.emit("message_update", {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", delta: "x" },
	}, ctx);
	await app.emit("message_end", { type: "message_end", message }, ctx);
	await app.emit("turn_end", { type: "turn_end" }, ctx);
	await app.emit("agent_settled", { type: "agent_settled" }, ctx);
}

describe("statusline migration lifecycle", () => {
	it("moves editor metadata only while appearance owns the editor", async () => {
		const { cwd } = config({
			widgets: ["path", "model", "mode", "fast", "state"],
			iconMode: "plain",
		});
		const app = harness(async () => ({ code: 1, stdout: "", stderr: "" }));
		const ctx = app.makeCtx(cwd);
		ctx.model.reasoning = true;
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const footer = app.mountFooter(new Map([["mode", "EDIT"], ["fast", ""]]));
		assert.ok(footer);
		assert.match(footer.render(120).join("\n"), /model high.*EDIT.*fast/);

		let source: { render(width: number): string } | undefined;
		let ownsEditor = true;
		app.emitBus("terrific-pi:statusline:editor-v1", {
			version: 1,
			active: true,
			ownsEditor: () => ownsEditor,
			attach(value: { render(width: number): string }) { source = value; },
		});
		assert.ok(source);
		assert.match(source.render(120), /model high.*EDIT.*fast/);
		assert.doesNotMatch(footer.render(120).join("\n"), /model high|EDIT|fast/);

		ownsEditor = false;
		assert.match(footer.render(120).join("\n"), /model high.*EDIT.*fast/);
		ownsEditor = true;
		assert.doesNotMatch(footer.render(120).join("\n"), /model high|EDIT|fast/);

		app.emitBus("terrific-pi:statusline:editor-v1", { version: 1, active: false });
		assert.match(footer.render(120).join("\n"), /model high.*EDIT.*fast/);
	});

	it("replays an editor attachment requested before the footer source mounts", async () => {
		const { cwd } = config({
			widgets: ["path", "model", "mode", "fast"],
			iconMode: "plain",
		});
		const app = harness(async () => ({ code: 1, stdout: "", stderr: "" }));
		const ctx = app.makeCtx(cwd);
		ctx.model.reasoning = true;
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

		let source: { render(width: number): string } | undefined;
		app.emitBus("terrific-pi:statusline:editor-v1", {
			version: 1,
			active: true,
			ownsEditor: () => true,
			attach(value: { render(width: number): string }) { source = value; },
		});
		assert.equal(Boolean(source), false);

		const footer = app.mountFooter(new Map([["mode", "EDIT"], ["fast", "fast"]]));
		assert.ok(source);
		assert.match(source.render(120), /model high.*EDIT.*fast/);
		assert.doesNotMatch(footer?.render(120).join("\n") ?? "", /model high|EDIT|fast/);
	});

	it("cancels an editor request before the footer source mounts", async () => {
		const { cwd } = config({
			widgets: ["model", "mode", "fast"],
			iconMode: "plain",
		});
		const app = harness(async () => ({ code: 1, stdout: "", stderr: "" }));
		const ctx = app.makeCtx(cwd);
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

		let attached = false;
		app.emitBus("terrific-pi:statusline:editor-v1", {
			version: 1,
			active: true,
			ownsEditor: () => true,
			attach() { attached = true; },
		});
		app.emitBus("terrific-pi:statusline:editor-v1", { version: 1, active: false });

		const footer = app.mountFooter(new Map([["mode", "EDIT"], ["fast", "fast"]]));
		assert.equal(attached, false);
		assert.match(footer?.render(120).join("\n") ?? "", /model.*EDIT.*fast/);
	});

	it("performs zero exec calls when worktree runtime and branchDiff are disabled", async () => {
		const { cwd } = config({ widgets: ["path"] });
		let calls = 0;
		const app = harness(async () => {
			calls += 1;
			return { code: 0, stdout: "", stderr: "" };
		});
		const ctx = app.makeCtx(cwd);
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		app.mountFooter();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(calls, 0);
	});

	it("queries enabled worktree and runtime through pi.exec without shell", async () => {
		const { cwd } = config({ widgets: ["worktree", "runtime"] });
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const calls: Array<[string, string[], { cwd: string; timeout: number }]> = [];
		const app = harness(async (command, args, options) => {
			calls.push([command, args, options]);
			if (command === "git") return { code: 0, stdout: "# branch.oid abcdef123\n# branch.head main\n", stderr: "" };
			return { code: 0, stdout: "v22.10.0\n", stderr: "" };
		});
		const ctx = app.makeCtx(cwd);
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		app.mountFooter();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(calls.some(([command]) => command === "git"), true);
		assert.equal(calls.some(([command]) => command === "node"), true);
		assert.equal(calls.every(([command]) => command !== "sh" && command !== "bash"), true);
	});

	it("renders run widgets and notifies at most once from the same settled snapshot", async () => {
		const { cwd } = config({ widgets: ["runTtft"], iconMode: "plain", runNotification: true });
		const app = harness(async () => ({ code: 1, stdout: "", stderr: "" }));
		const ctx = app.makeCtx(cwd);
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const footer = app.mountFooter();
		await settledRun(app, ctx);
		await app.emit("agent_settled", { type: "agent_settled" }, ctx);
		assert.equal(app.notifications.filter((text) => text.includes("TTFT")).length, 1);
		assert.match(footer?.render(120).join("\n") ?? "", /TTFT /);
	});

	it("collects and renders a run widget without enabling notifications", async () => {
		const { cwd } = config({ widgets: ["runTtft"], iconMode: "plain" });
		const app = harness(async () => ({ code: 1, stdout: "", stderr: "" }));
		const ctx = app.makeCtx(cwd);
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const footer = app.mountFooter();
		await settledRun(app, ctx);
		assert.match(footer?.render(120).join("\n") ?? "", /TTFT /);
		assert.equal(app.notifications.length, 0);
	});

	it("clears settled run widgets on tree and compact without re-notifying", async () => {
		for (const eventName of ["session_tree", "session_compact"]) {
			const { cwd } = config({ widgets: ["runTtft"], iconMode: "plain", runNotification: true });
			const app = harness(async () => ({ code: 1, stdout: "", stderr: "" }));
			const ctx = app.makeCtx(cwd);
			await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			const footer = app.mountFooter();
			await settledRun(app, ctx);
			assert.match(footer?.render(120).join("\n") ?? "", /TTFT /, eventName);
			await app.emit(eventName, { type: eventName }, ctx);
			assert.doesNotMatch(footer?.render(120).join("\n") ?? "", /TTFT /, eventName);
			await app.emit("agent_settled", { type: "agent_settled" }, ctx);
			assert.equal(app.notifications.filter((text) => text.includes("TTFT")).length, 1, eventName);
		}
	});

	it("does not notify in print json or rpc modes", async () => {
		for (const mode of ["print", "json", "rpc"]) {
			const { cwd } = config({ widgets: ["path"], runNotification: true });
			const app = harness(async () => ({ code: 1, stdout: "", stderr: "" }));
			const tuiCtx = app.makeCtx(cwd);
			await app.emit("session_start", { type: "session_start", reason: "startup" }, tuiCtx);
			await settledRun(app, app.makeCtx(cwd, mode));
			assert.equal(app.notifications.filter((text) => text.includes("TPS")).length, 0, mode);
		}
	});

	it("resets aborted/error agent_end attempts and emits only the successful retry", async () => {
		for (const stopReason of ["aborted", "error"]) {
			const { cwd } = config({ widgets: ["path"], runNotification: true });
			const app = harness(async () => ({ code: 1, stdout: "", stderr: "" }));
			const ctx = app.makeCtx(cwd);
			await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			const failed = assistantMessage(stopReason);
			await app.emit("agent_start", { type: "agent_start" }, ctx);
			await app.emit("turn_start", { type: "turn_start" }, ctx);
			await app.emit("message_start", { type: "message_start", message: failed }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 2));
			await app.emit("message_update", { type: "message_update", message: failed, assistantMessageEvent: { type: "text_delta", delta: "x" } }, ctx);
			await app.emit("message_end", { type: "message_end", message: failed }, ctx);
			await app.emit("turn_end", { type: "turn_end" }, ctx);
			await app.emit("agent_end", { type: "agent_end", messages: [failed] }, ctx);
			await app.emit("agent_settled", { type: "agent_settled" }, ctx);
			assert.equal(app.notifications.filter((text) => text.includes("TPS")).length, 0, stopReason);

			await settledRun(app, ctx);
			await app.emit("agent_settled", { type: "agent_settled" }, ctx);
			assert.equal(app.notifications.filter((text) => text.includes("TPS")).length, 1, stopReason);
		}
	});

	it("reload enables project widgets immediately for the current cwd", async () => {
		const { cwd, path } = config({ widgets: ["path"] });
		let calls = 0;
		const app = harness(async () => {
			calls += 1;
			return { code: 0, stdout: "# branch.oid abc\n# branch.head enabled\n", stderr: "" };
		});
		const ctx = app.makeCtx(cwd);
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		app.mountFooter();
		writeFileSync(path, JSON.stringify({ widgets: ["worktree"] }));
		await app.commands.get("statusline").handler("reload", ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(calls, 1);
	});

	it("reload disable clears old project values and invalidates a pending request", async () => {
		const { cwd, path } = config({ widgets: ["worktree"] });
		let resolveExec!: (value: any) => void;
		const app = harness(async () => new Promise((resolve) => { resolveExec = resolve; }));
		const ctx = app.makeCtx(cwd);
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const footer = app.mountFooter();
		await new Promise((resolve) => setTimeout(resolve, 5));
		writeFileSync(path, JSON.stringify({ widgets: ["path"] }));
		await app.commands.get("statusline").handler("reload", ctx);
		resolveExec({ code: 0, stdout: "# branch.oid abc\n# branch.head stale\n", stderr: "" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.doesNotMatch(footer.render(200).join("\n"), /stale/);
	});

	it("keeps generation B mounted when generation A resolves late", async () => {
		const { cwd, path } = config({ widgets: ["worktree"] });
		let calls = 0;
		let resolveA!: (value: any) => void;
		const app = harness(async () => {
			calls += 1;
			if (calls === 1) return new Promise((resolve) => { resolveA = resolve; });
			return { code: 0, stdout: "# branch.oid bbb\n# branch.head fresh-B\n", stderr: "" };
		});
		const ctx = app.makeCtx(cwd);
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const footer = app.mountFooter();
		await new Promise((resolve) => setTimeout(resolve, 5));
		writeFileSync(path, JSON.stringify({ widgets: ["worktree"] }));
		await app.commands.get("statusline").handler("reload", ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(calls, 2);
		assert.match(footer.render(200).join("\n"), /fresh-B/);
		resolveA({ code: 0, stdout: "# branch.oid aaa\n# branch.head stale-A\n", stderr: "" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const rendered = footer.render(200).join("\n");
		assert.match(rendered, /fresh-B/);
		assert.doesNotMatch(rendered, /stale-A/);
	});

	it("apply invalidates the reload request and keeps the newest project generation", async () => {
		const { cwd } = config({ widgets: ["worktree"], iconMode: "emoji" });
		const pending: Array<(value: any) => void> = [];
		let calls = 0;
		const app = harness(async () => {
			calls += 1;
			if (calls < 3) return new Promise((resolve) => pending.push(resolve));
			return { code: 0, stdout: "# branch.oid ccc\n# branch.head fresh-apply\n", stderr: "" };
		});
		const choices: Array<string | { value: string; delay: number }> = [
			{ value: "Appearance", delay: 5 },
			"Icon mode",
			"ascii",
			"Back",
			"Done",
		];
		const ctx = app.makeCtx(cwd, "tui", choices);
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const footer = app.mountFooter();
		await new Promise((resolve) => setTimeout(resolve, 5));
		await app.commands.get("statusline").handler("", ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(calls, 3);
		assert.match(footer.render(200).join("\n"), /fresh-apply/);
		pending[0]!({ code: 0, stdout: "# branch.oid aaa\n# branch.head stale-start\n", stderr: "" });
		pending[1]!({ code: 0, stdout: "# branch.oid bbb\n# branch.head stale-reload\n", stderr: "" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const rendered = footer.render(200).join("\n");
		assert.match(rendered, /fresh-apply/);
		assert.doesNotMatch(rendered, /stale-/);
	});

	it("rejects stale async results after shutdown generation changes", async () => {
		const { cwd } = config({ widgets: ["worktree"] });
		let resolveExec!: (value: any) => void;
		const pending = new Promise((resolve) => { resolveExec = resolve; });
		const app = harness(async () => pending);
		const ctx = app.makeCtx(cwd);
		await app.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		app.mountFooter();
		await new Promise((resolve) => setTimeout(resolve, 5));
		await app.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
		resolveExec({ code: 0, stdout: "# branch.oid abc\n# branch.head stale\n", stderr: "" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(app.renders, 0);
	});
});
