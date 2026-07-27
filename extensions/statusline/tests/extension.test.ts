import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import statusline from "../extensions/statusline.ts";
import { DEFAULT_CONFIG } from "../lib/config.ts";

type Handler = (event?: any, ctx?: any) => any;

function files(profile: string, layout: "single" | "stacked" | "terrific") {
	const dir = mkdtempSync(join(tmpdir(), "statusline-extension-"));
	writeFileSync(join(dir, "terrific.json"), profile, "utf8");
	const configPath = join(dir, "statusline.json");
	writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, layout }), "utf8");
	return { dir, configPath };
}

function makeUi() {
	const visibility: boolean[] = [];
	const footers: any[] = [];
	const notifications: string[] = [];
	return {
		visibility, footers, notifications,
		ui: {
			setWorkingVisible(value: boolean) { visibility.push(value); },
			setFooter(factory: any) { footers.push(factory); },
			notify(message: string) { notifications.push(message); },
		},
	};
}

function harness(uiState = makeUi(), extension: typeof statusline = statusline) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const pi = {
		events: { on(name: string, handler: Handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); } },
		on(name: string, handler: Handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
		getThinkingLevel: () => "high",
	};
	extension(pi as never);
	const ctx = {
		mode: "tui", cwd: "/tmp/project", ui: uiState.ui,
		model: { id: "gpt-5", reasoning: true },
		modelRegistry: { isUsingOAuth: () => false, getApiKeyAndHeaders: async () => ({ ok: false, error: "no" }) },
		sessionManager: { getBranch: () => [], getSessionName: () => "demo" },
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
	};
	return {
		...uiState, ctx, commands,
		async emit(name: string, event: any = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		mountFooter(
			rows = 24,
			requestRender: () => void = () => {},
			onBranchChange: (callback: () => void) => () => void = () => () => {},
		) {
			const factory = uiState.footers.at(-1);
			assert.equal(typeof factory, "function");
			return factory(
				{ requestRender, terminal: { rows } },
				{ fg: (_color: string, text: string) => text },
				{ getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange },
			);
		},
	};
}

async function withEnv<T>(dir: string, configPath: string, run: () => Promise<T>): Promise<T> {
	const oldDir = process.env.PI_CODING_AGENT_DIR;
	const oldConfig = process.env.PI_STATUSLINE_CONFIG;
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_STATUSLINE_CONFIG = configPath;
	try { return await run(); }
	finally {
		if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
		if (oldConfig === undefined) delete process.env.PI_STATUSLINE_CONFIG; else process.env.PI_STATUSLINE_CONFIG = oldConfig;
	}
}

const ACTIVE = JSON.stringify({ appearance: { profile: "terrific-native-v1" } });

it("offers only reload completion and rejects unknown arguments", async () => {
	const f = files("{}", "single");
	await withEnv(f.dir, f.configPath, async () => {
		const h = harness();
		const command = h.commands.get("statusline");
		assert.deepEqual(command.getArgumentCompletions("").map((item: { value: string }) => item.value), ["reload"]);
		await command.handler("unknown", h.ctx);
		assert.match(h.notifications.at(-1) ?? "", /Usage: \/statusline \[reload\]/);
		assert.equal(h.footers.length, 0);
	});
});

describe("Terrific footer lifecycle", { concurrency: false }, () => {
	it("hides working status only when configured and profile-active", async () => {
		for (const [profile, layout, expected] of [[ACTIVE, "terrific", false], ["{}", "terrific", true], [ACTIVE, "single", true]] as const) {
			const f = files(profile, layout);
			await withEnv(f.dir, f.configPath, async () => {
				const h = harness();
				await h.emit("session_start");
				assert.equal(h.visibility.at(-1), expected);
				assert.equal(h.footers.length, 1);
			});
		}
	});

	it("switches visibility immediately on config reload and keeps profile errors silent", async () => {
		const f = files("{", "terrific");
		await withEnv(f.dir, f.configPath, async () => {
			const h = harness();
			await h.emit("session_start");
			assert.equal(h.visibility.at(-1), true);
			assert.deepEqual(h.notifications, []);
		});
		writeFileSync(join(f.dir, "terrific.json"), ACTIVE);
		await withEnv(f.dir, f.configPath, async () => {
			const h = harness();
			await h.emit("session_start");
			assert.equal(h.visibility.at(-1), false);
			writeFileSync(f.configPath, JSON.stringify({ ...DEFAULT_CONFIG, layout: "single" }));
			await h.commands.get("statusline").handler("reload", h.ctx);
			assert.equal(h.visibility.at(-1), true);
			writeFileSync(f.configPath, JSON.stringify({ ...DEFAULT_CONFIG, layout: "terrific" }));
			await h.commands.get("statusline").handler("reload", h.ctx);
			assert.equal(h.visibility.at(-1), false);
		});
	});

	it("rereads profile and statusline edits before the next request", async () => {
		const f = files("{}", "terrific");
		await withEnv(f.dir, f.configPath, async () => {
			const h = harness();
			await h.emit("session_start");
			assert.equal(h.visibility.at(-1), true);

			writeFileSync(join(f.dir, "terrific.json"), ACTIVE);
			await h.emit("before_agent_start", { systemPromptOptions: { contextFiles: [], skills: [], selectedTools: [] } });
			assert.equal(h.visibility.at(-1), false);

			writeFileSync(f.configPath, JSON.stringify({ ...DEFAULT_CONFIG, layout: "single" }));
			await h.emit("before_agent_start", { systemPromptOptions: { contextFiles: [], skills: [], selectedTools: [] } });
			assert.equal(h.visibility.at(-1), true);
		});
	});

	it("shares ownership across cache-busted module evaluations", async () => {
		const f = files(ACTIVE, "terrific");
		await withEnv(f.dir, f.configPath, async () => {
			const first = (await import(`../extensions/statusline.ts?owner=${Date.now()}-1`)).default;
			const second = (await import(`../extensions/statusline.ts?owner=${Date.now()}-2`)).default;
			assert.notEqual(first, second);
			const shared = makeUi();
			const old = harness(shared, first);
			await old.emit("session_start");
			const oldFooter = old.mountFooter();
			const fresh = harness(shared, second);
			await fresh.emit("session_start");
			const freshFooter = fresh.mountFooter();
			await old.emit("session_shutdown");
			oldFooter.dispose();
			assert.equal(shared.visibility.at(-1), false);
			freshFooter.dispose();
			assert.equal(shared.visibility.at(-1), true);
		});
	});

	it("keeps the current timer and duration when an earlier same-instance footer disposes late", async () => {
		const originalSet = globalThis.setInterval;
		const originalClear = globalThis.clearInterval;
		const originalNow = Date.now;
		const active = new Map<number, () => void>();
		let id = 0;
		let now = 1_000;
		Date.now = () => now;
		(globalThis as any).setInterval = (callback: () => void) => { active.set(++id, callback); return id; };
		(globalThis as any).clearInterval = (timer: number) => { active.delete(timer); };
		const f = files(ACTIVE, "terrific");
		try {
			await withEnv(f.dir, f.configPath, async () => {
				const h = harness();
				let oldBranchUnsubscribes = 0;
				await h.emit("session_start");
				const oldFooter = h.mountFooter(24, () => {}, () => () => { oldBranchUnsubscribes += 1; });
				await h.emit("session_start");
				const renders = { count: 0 };
				const currentFooter = h.mountFooter(24, () => { renders.count += 1; });
				await h.emit("agent_start");
				const before = currentFooter.render(120).join("\n");
				const rendersBeforeTick = renders.count;

				oldFooter.dispose();

				assert.equal(oldBranchUnsubscribes, 1);
				assert.equal(active.size, 1);
				now += 2_000;
				active.values().next().value!();
				assert.equal(renders.count - rendersBeforeTick, 1);
				const after = currentFooter.render(120).join("\n");
				assert.notEqual(after, before);
				assert.match(after, /2s\/2s/);
				assert.equal(h.visibility.at(-1), false);
				currentFooter.dispose();
				assert.equal(active.size, 0);
				assert.equal(h.visibility.at(-1), true);
			});
		} finally {
			globalThis.setInterval = originalSet;
			globalThis.clearInterval = originalClear;
			Date.now = originalNow;
		}
	});
});

describe("duration timer cadence", { concurrency: false }, () => {
	it("uses one 133/250ms timer, restarts on layout switch, and stops idle/shutdown", async () => {
		const originalSet = globalThis.setInterval;
		const originalClear = globalThis.clearInterval;
		const active = new Map<number, () => void>();
		const cadences: number[] = [];
		let id = 0;
		(globalThis as any).setInterval = (callback: () => void, ms: number) => { cadences.push(ms); active.set(++id, callback); return id; };
		(globalThis as any).clearInterval = (timer: number) => { active.delete(timer); };
		const f = files(ACTIVE, "terrific");
		try {
			await withEnv(f.dir, f.configPath, async () => {
				const h = harness();
				await h.emit("session_start");
				assert.equal(active.size, 0);
				await h.emit("agent_start");
				assert.deepEqual(cadences, [133]);
				assert.equal(active.size, 1);
				writeFileSync(f.configPath, JSON.stringify({ ...DEFAULT_CONFIG, layout: "single" }));
				await h.commands.get("statusline").handler("reload", h.ctx);
				assert.deepEqual(cadences, [133, 250]);
				assert.equal(active.size, 1);
				await h.emit("agent_settled");
				assert.equal(active.size, 0);
				await h.emit("agent_start");
				await h.emit("session_shutdown");
				assert.equal(active.size, 0);
			});
		} finally { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; }
	});

	it("ignores a stale 133ms callback after switching the active tracker to 250ms", async () => {
		const originalSet = globalThis.setInterval;
		const originalClear = globalThis.clearInterval;
		const callbacks: Array<() => void> = [];
		const cadences: number[] = [];
		let id = 0;
		(globalThis as any).setInterval = (callback: () => void, ms: number) => { callbacks.push(callback); cadences.push(ms); return ++id; };
		(globalThis as any).clearInterval = () => {};
		const f = files(ACTIVE, "terrific");
		try {
			await withEnv(f.dir, f.configPath, async () => {
				const h = harness();
				await h.emit("session_start");
				const renders = { count: 0 };
				const footer = h.mountFooter(24, () => { renders.count += 1; });
				await h.emit("agent_start");
				const stale133msCallback = callbacks[0]!;
				writeFileSync(f.configPath, JSON.stringify({ ...DEFAULT_CONFIG, layout: "single" }));
				await h.commands.get("statusline").handler("reload", h.ctx);
				assert.deepEqual(cadences, [133, 250]);
				const rendersBeforeStaleCallback = renders.count;

				stale133msCallback();
				const staleRenderRequests = renders.count - rendersBeforeStaleCallback;
				writeFileSync(f.configPath, JSON.stringify({ ...DEFAULT_CONFIG, layout: "terrific" }));
				await h.commands.get("statusline").handler("reload", h.ctx);
				const spinner = footer.render(120).join("\n").match(/([⠋⠙⠹⠸⠼⠴⠦⠧]) Thinking/)?.[1];
				assert.deepEqual({ staleRenderRequests, spinner }, { staleRenderRequests: 0, spinner: "⠋" });
				footer.dispose();
			});
		} finally { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; }
	});

	it("advances the Terrific spinner from the same timer and stops on settle/shutdown", async () => {
		const originalSet = globalThis.setInterval;
		const originalClear = globalThis.clearInterval;
		const originalTerm = process.env.TERM;
		process.env.TERM = "xterm";
		const active = new Map<number, () => void>();
		let id = 0;
		(globalThis as any).setInterval = (callback: () => void) => { active.set(++id, callback); return id; };
		(globalThis as any).clearInterval = (timer: number) => { active.delete(timer); };
		const f = files(ACTIVE, "terrific");
		try {
			await withEnv(f.dir, f.configPath, async () => {
				const h = harness();
				await h.emit("session_start");
				const footer = h.mountFooter();
				assert.equal(active.size, 0);
				await h.emit("agent_start");
				const before = footer.render(120).join("\n");
				const firstFrame = before.match(/([⠋⠙⠹⠸⠼⠴⠦⠧]) Thinking/)?.[1];
				active.values().next().value!();
				const after = footer.render(120).join("\n");
				assert.notEqual(before, after);
				assert.notEqual(after.match(/([⠋⠙⠹⠸⠼⠴⠦⠧]) Thinking/)?.[1], firstFrame);
				await h.emit("agent_settled");
				assert.equal(active.size, 0);
				assert.doesNotMatch(footer.render(120).join("\n"), /[⠋⠙⠹⠸⠼⠴⠦⠧*] Ready/);
				await h.emit("agent_start");
				assert.equal(footer.render(120).join("\n").match(/([⠋⠙⠹⠸⠼⠴⠦⠧]) Thinking/)?.[1], firstFrame);
				await h.emit("session_shutdown");
				assert.equal(active.size, 0);
			});
		} finally {
			globalThis.setInterval = originalSet;
			globalThis.clearInterval = originalClear;
			if (originalTerm === undefined) delete process.env.TERM;
			else process.env.TERM = originalTerm;
		}
	});

	it("prevents stale callbacks and cleanup across ten extension generations", async () => {
		const originalSet = globalThis.setInterval;
		const originalClear = globalThis.clearInterval;
		const active = new Map<number, () => void>();
		const callbacks: Array<() => void> = [];
		let id = 0;
		(globalThis as any).setInterval = (callback: () => void) => { callbacks.push(callback); active.set(++id, callback); return id; };
		(globalThis as any).clearInterval = (timer: number) => { active.delete(timer); };
		const f = files(ACTIVE, "terrific");
		try {
			await withEnv(f.dir, f.configPath, async () => {
				const shared = makeUi();
				let previous: { h: ReturnType<typeof harness>; footer: any; callback: () => void; renders: { count: number } } | undefined;
				for (let generation = 0; generation < 10; generation += 1) {
					const h = harness(shared);
					await h.emit("session_start");
					const renders = { count: 0 };
					const footer = h.mountFooter(24, () => { renders.count += 1; });
					await h.emit("agent_start");
					const callback = callbacks.at(-1)!;
					if (previous) {
						previous.footer.dispose();
						const before = previous.renders.count;
						previous.callback();
						assert.equal(previous.renders.count, before);
						await previous.h.emit("session_shutdown");
						assert.equal(shared.visibility.at(-1), false);
					}
					previous = { h, footer, callback, renders };
				}
				previous!.footer.dispose();
				assert.equal(active.size, 0);
				assert.equal(shared.visibility.at(-1), true);
			});
		} finally { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; }
	});
});

it("keeps one footer owner and no forbidden presentation setters/status", () => {
	const source = readFileSync(new URL("../extensions/statusline.ts", import.meta.url), "utf8");
	assert.equal((source.match(/\.setFooter\(/g) ?? []).length, 1);
	assert.doesNotMatch(source, /setHeader|setEditorComponent/);
	assert.doesNotMatch(source, /setStatus\(\s*["']appearance/);
});
