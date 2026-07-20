import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";

import modelProfileExtension from "../extensions/model-profile.ts";
import type { ApplyDeps } from "../lib/apply.ts";
import { profileLabel } from "../lib/config.ts";
import {
	CURRENT_SESSION_ENTRY,
	formatKeepCurrentLabel,
	formatKeepDefaultLabel,
	rememberPendingNewSelection,
	takePendingNewSelection,
	profilesForStartupList,
	readPreviousSessionSelection,
	runStartupPicker,
	startupDigitChoice,
} from "../lib/startup.ts";
import type { ModelProfileConfig } from "../lib/types.ts";

const config: ModelProfileConfig = {
	startup: true,
	startupScope: "session",
	profiles: [
		{
			id: "1",
			alias: "default",
			label: "default",
			provider: "openai",
			model: "gpt-5.6-sol",
			thinking: "medium",
			hotkey: "alt+1",
		},
		{
			id: "2",
			alias: "lunamax",
			label: "lunamax",
			provider: "openai",
			model: "gpt-5.6-luna",
			thinking: "max",
			hotkey: "alt+2",
		},
	],
};

function deps(overrides: Partial<ApplyDeps> = {}): ApplyDeps {
	return {
		findModel: (provider, modelId) => ({ provider, id: modelId }),
		setModel: async () => true,
		setThinkingLevel: () => {},
		getThinkingLevel: () => "high",
		snapshotSettingsFile: () => ({
			ok: true,
			path: "/settings.json",
			exists: true,
			content: "{}",
			mode: 0o600,
		}),
		restoreSettingsFile: () => ({ ok: true }),
		writeSettingsDefaults: () => ({ ok: true }),
		...overrides,
	};
}

const current = { provider: "openai", id: "gpt-5.6-sol" };
const keepLabel = formatKeepCurrentLabel(current, "medium");
const coldKeepLabel = formatKeepDefaultLabel(current, "medium");

describe("startup Keep labels", () => {
	it("names the activated session model for /new", () => {
		assert.equal(
			formatKeepCurrentLabel({ provider: "openai", id: "gpt-5.6-sol" }, "max"),
			"Keep current session · openai/gpt-5.6-sol · max",
		);
	});

	it("names the global default for a cold start", () => {
		assert.equal(
			formatKeepDefaultLabel({ provider: "openai", id: "gpt-5.6-sol" }, "max"),
			"Keep global default · openai/gpt-5.6-sol · max",
		);
	});
});

describe("pending /new selection", () => {
	it("bridges an unflushed old session to its exact replacement once", () => {
		const target = "/tmp/model-profile-new.jsonl";
		const selection = {
			model: { provider: "anthropic", id: "claude-unsaved" },
			thinking: "high" as const,
		};
		rememberPendingNewSelection(target, selection);
		assert.equal(takePendingNewSelection("/tmp/other.jsonl"), undefined);
		assert.deepEqual(takePendingNewSelection(target), selection);
		assert.equal(takePendingNewSelection(target), undefined);
	});
});

describe("/new lifecycle", () => {
	it("restores an unflushed current session without changing global defaults", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mp-new-lifecycle-"));
		const settingsPath = join(agentDir, "settings.json");
		const globalDefaults = {
			defaultProvider: "openai",
			defaultModel: "gpt-global",
			defaultThinkingLevel: "medium",
		};
		writeFileSync(join(agentDir, "terrific.json"), JSON.stringify({
			modelProfile: { startup: true, profiles: [] },
		}), "utf8");
		writeFileSync(settingsPath, JSON.stringify(globalDefaults), "utf8");

		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
			const appended: Array<{ type: string; data: unknown }> = [];
			let oldThinking = "high";
			const oldPi = {
				on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
					const list = handlers.get(name) ?? [];
					list.push(handler);
					handlers.set(name, list);
				},
				registerCommand() {},
				registerShortcut() {},
				appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
				getThinkingLevel: () => oldThinking,
				setThinkingLevel(level: string) { oldThinking = level; },
				setModel: async () => true,
			};
			modelProfileExtension(oldPi as never);
			const targetSessionFile = join(agentDir, "new.jsonl");
			await handlers.get("session_shutdown")?.[0]?.(
				{ reason: "new", targetSessionFile },
				{
					cwd: agentDir,
					model: { provider: "anthropic", id: "claude-unsaved" },
					isProjectTrusted: () => false,
				},
			);
			assert.deepEqual(appended, [{
				type: CURRENT_SESSION_ENTRY,
				data: {
					model: { provider: "anthropic", id: "claude-unsaved" },
					thinking: "high",
				},
			}]);

			const newHandlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
			let activeModel = { provider: "openai", id: "gpt-global" };
			let thinking = "medium";
			const newPi = {
				on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
					const list = newHandlers.get(name) ?? [];
					list.push(handler);
					newHandlers.set(name, list);
				},
				registerCommand() {},
				registerShortcut() {},
				appendEntry() {},
				getThinkingLevel: () => thinking,
				setThinkingLevel(level: string) {
					thinking = level;
					const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
					settings.defaultThinkingLevel = level;
					writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
				},
				setModel: async (model: { provider: string; id: string }) => {
					activeModel = { provider: model.provider, id: model.id };
					const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
					settings.defaultProvider = model.provider;
					settings.defaultModel = model.id;
					writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
					return true;
				},
			};
			modelProfileExtension(newPi as never);
			const ui = {
				select: async () => undefined,
				notify() {},
				custom: async (factory: any) => new Promise((resolve) => {
					const component = factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						resolve,
					);
					component.handleInput("\r");
				}),
			};
			const newCtx: any = {
				cwd: agentDir,
				hasUI: true,
				mode: "tui",
				ui,
				isProjectTrusted: () => false,
				sessionManager: { getSessionFile: () => targetSessionFile },
				get model() { return activeModel; },
				modelRegistry: {
					find: (provider: string, id: string) => ({ provider, id }),
					getAvailable: () => [],
				},
			};
			await newHandlers.get("session_start")?.[0]?.(
				{ reason: "new", previousSessionFile: join(agentDir, "missing.jsonl") },
				newCtx,
			);

			assert.deepEqual(activeModel, { provider: "anthropic", id: "claude-unsaved" });
			assert.equal(thinking, "high");
			assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), globalDefaults);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});

describe("readPreviousSessionSelection", () => {
	it("reads the exact model and thinking captured before /new", () => {
		const dir = mkdtempSync(join(tmpdir(), "mp-previous-session-"));
		const path = join(dir, "session.jsonl");
		writeFileSync(path, [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2026-07-20T00:00:00.000Z",
				cwd: dir,
			}),
			JSON.stringify({
				type: "custom",
				id: "a1b2c3d4",
				parentId: null,
				timestamp: "2026-07-20T00:00:01.000Z",
				customType: "model-profile-current",
				data: {
					model: { provider: "anthropic", id: "claude-session" },
					thinking: "high",
				},
			}),
		].join("\n") + "\n", "utf8");

		assert.deepEqual(readPreviousSessionSelection(path), {
			model: { provider: "anthropic", id: "claude-session" },
			thinking: "high",
		});
	});

	it("fails closed for missing or malformed session state", () => {
		assert.equal(readPreviousSessionSelection(undefined), undefined);
		assert.equal(readPreviousSessionSelection("/missing/model-profile-session.jsonl"), undefined);
	});
});

describe("startupDigitChoice", () => {
	const options = [
		"Keep current session · anthropic/claude-session · high",
		profileLabel(config.profiles[0]!),
		profileLabel(config.profiles[1]!),
		"0 · Browse all models…",
	];

	it("maps 0 to Browse and profile digits to their visible ids", () => {
		assert.equal(startupDigitChoice("0", options), options[3]);
		assert.equal(startupDigitChoice("1", options), options[1]);
		assert.equal(startupDigitChoice("2", options), options[2]);
	});

	it("supports Kitty keyboard protocol digit sequences", () => {
		setKittyProtocolActive(true);
		try {
			assert.equal(startupDigitChoice("\u001b[49u", options), options[1]);
		} finally {
			setKittyProtocolActive(false);
		}
	});

	it("ignores non-digits and unavailable ids", () => {
		assert.equal(startupDigitChoice("9", options), undefined);
		assert.equal(startupDigitChoice("enter", options), undefined);
	});
});

describe("profilesForStartupList", () => {
	it("keeps default first even when it matches the activated model", () => {
		const listed = profilesForStartupList([...config.profiles].reverse(), current, "medium");
		assert.deepEqual(
			listed.map((p) => p.id),
			["1", "2"],
		);
	});
});

describe("runStartupPicker", () => {
	it("skips resume/fork/reload", async () => {
		for (const reason of ["resume", "fork", "reload"] as const) {
			const result = await runStartupPicker({
				reason,
				hasUI: true,
				config,
				deps: deps(),
				currentModel: current,
				currentThinking: "medium",
				getAvailable: () => [],
				ui: { select: async () => undefined },
			});
			assert.deepEqual(result, { action: "skipped", reason: `reason:${reason}` });
		}
	});

	it("returns to the top-level picker when scope selection is dismissed", async () => {
		const answers: Array<string | undefined> = [profileLabel(config.profiles[0]!), undefined, undefined];
		const titles: string[] = [];
		const result = await runStartupPicker({
			reason: "startup",
			hasUI: true,
			config,
			deps: deps(),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [],
			ui: {
				select: async (title) => {
					titles.push(title);
					return answers.shift();
				},
			},
		});

		assert.deepEqual(result, { action: "cancelled", reason: "dismissed" });
		assert.deepEqual(titles, ["Startup model profile", "Apply scope", "Startup model profile"]);
	});

	it("keeps the activated global default on cold startup", async () => {
		const result = await runStartupPicker({
			reason: "startup",
			hasUI: true,
			config,
			deps: deps(),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [],
			ui: { select: async () => coldKeepLabel },
		});
		assert.deepEqual(result, { action: "cancelled", reason: "keep-current" });
	});

	it("restores the previous session selection when /new keeps current", async () => {
		const previous = { provider: "anthropic", id: "claude-session" };
		const previousLabel = formatKeepCurrentLabel(previous, "high");
		let thinking: "medium" | "high" = "medium";
		const settings: {
			defaultProvider: string;
			defaultModel: string;
			defaultThinkingLevel: "medium" | "high";
		} = {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium",
		};

		const result = await runStartupPicker({
			reason: "new",
			hasUI: true,
			config,
			deps: deps({
				getThinkingLevel: () => thinking,
				snapshotSettingsFile: () => ({
					ok: true,
					path: "/settings.json",
					exists: true,
					content: JSON.stringify(settings),
					mode: 0o600,
				}),
				setModel: async (model) => {
					settings.defaultProvider = model.provider;
					settings.defaultModel = model.id;
					return true;
				},
				setThinkingLevel: (level) => {
					thinking = level as "medium" | "high";
					settings.defaultThinkingLevel = thinking;
				},
				restoreSettingsFile: (snapshot) => {
					if (!snapshot.exists) return { ok: false, error: "expected settings file" };
					Object.assign(settings, JSON.parse(snapshot.content) as typeof settings);
					return { ok: true };
				},
			}),
			currentModel: previous,
			currentThinking: "high",
			getAvailable: () => [],
			ui: { select: async () => previousLabel },
		});

		assert.equal(result.action, "applied");
		if (result.action === "applied") {
			assert.equal(result.source, "current");
		}
		assert.equal(thinking, "high");
		assert.deepEqual(settings, {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium",
		});
	});

	it("does not set a model for /new Keep when settings cannot be safely snapshotted", async () => {
		const previous = { provider: "anthropic", id: "claude-session" };
		let setModelCalls = 0;
		const input = deps({
			snapshotSettingsFile: () => ({ ok: false, path: "/settings.json", error: "permission denied" }),
			setModel: async () => {
				setModelCalls += 1;
				return true;
			},
		});

		const result = await runStartupPicker({
			reason: "new",
			hasUI: true,
			config,
			deps: input,
			currentModel: previous,
			currentThinking: "high",
			getAvailable: () => [],
			ui: { select: async () => formatKeepCurrentLabel(previous, "high") },
		});

		assert.equal(result.action, "cancelled");
		assert.equal(setModelCalls, 0);
	});

	it("skips when startup disabled", async () => {
		const result = await runStartupPicker({
			reason: "new",
			hasUI: true,
			config: { ...config, startup: false },
			deps: deps(),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [],
			ui: { select: async () => undefined },
		});
		assert.deepEqual(result, { action: "skipped", reason: "startup-disabled" });
	});

	it("uses the dedicated startup selector only for the main list", async () => {
		let startupCalls = 0;
		const nestedTitles: string[] = [];
		const result = await runStartupPicker({
			reason: "startup",
			hasUI: true,
			config,
			deps: deps(),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [],
			ui: {
				selectStartup: async (_title, options) => {
					startupCalls += 1;
					return options.find((option) => option.startsWith("2 · "));
				},
				select: async (title, options) => {
					nestedTitles.push(title);
					return options[0];
				},
			},
		});

		assert.equal(result.action, "applied");
		assert.equal(startupCalls, 1);
		assert.deepEqual(nestedTitles, ["Apply scope"]);
	});

	it("applies a non-current profile", async () => {
		const answers = [profileLabel(config.profiles[1]!), "session — this chat only"];
		const result = await runStartupPicker({
			reason: "new",
			hasUI: true,
			config,
			deps: deps(),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [],
			ui: { select: async () => answers.shift() },
		});
		assert.equal(result.action, "applied");
		if (result.action === "applied" && result.source === "profile") {
			assert.equal(result.profile.id, "2");
		}
	});

	it("lists keep first, default second, and numbered browse last", async () => {
		let seen: string[] | undefined;
		await runStartupPicker({
			reason: "startup",
			hasUI: true,
			config,
			deps: deps(),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [{ provider: "openai", id: "x" }],
			ui: {
				select: async (_title, options) => {
					seen = options;
					return coldKeepLabel;
				},
			},
		});
		assert.ok(seen);
		assert.equal(seen![0], coldKeepLabel);
		assert.equal(seen![1], profileLabel(config.profiles[0]!));
		assert.equal(seen![seen!.length - 1], "0 · Browse all models…");
		assert.ok(seen!.some((line) => line.includes("lunamax")));
	});

	it("browse all still works as last option", async () => {
		const answers = [
			"0 · Browse all models…",
			"openai",
			"openai/gpt-5.6-luna",
			"session — this chat only",
		];
		const settings = {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium" as const,
		};
		const result = await runStartupPicker({
			reason: "new",
			hasUI: true,
			config,
			deps: deps({
				getThinkingLevel: () => "max",
				snapshotSettingsFile: () => ({
					ok: true,
					path: "/settings.json",
					exists: true,
					content: JSON.stringify(settings),
					mode: 0o600,
				}),
				setModel: async (model) => {
					settings.defaultProvider = model.provider;
					settings.defaultModel = model.id;
					return true;
				},
				restoreSettingsFile: (snapshot) => {
					if (!snapshot.exists) return { ok: false, error: "expected settings file" };
					Object.assign(settings, JSON.parse(snapshot.content) as typeof settings);
					return { ok: true };
				},
			}),
			currentModel: current,
			currentThinking: "medium",
			getAvailable: () => [
				{ provider: "openai", id: "gpt-5.6-luna" },
				{ provider: "openai", id: "gpt-5.6-sol" },
			],
			ui: { select: async () => answers.shift() },
		});
		assert.equal(result.action, "applied");
		if (result.action === "applied" && result.source === "manual") {
			assert.equal(result.model.id, "gpt-5.6-luna");
			assert.equal(result.settingsRestored, true);
		}
		assert.deepEqual(settings, {
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "medium",
		});
	});
});
