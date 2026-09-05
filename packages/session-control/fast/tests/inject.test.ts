import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import fastExtension, {
	hasFastPreference,
	injectPriority,
	isFastActive,
	isGptModelId,
	loadFastEnabled,
	readSessionFastState,
	saveFastEnabled,
	shouldInjectPriority,
	supportsFastApi,
	supportsFastModel,
} from "../extensions/fast.ts";

function createExtensionHarness(options: {
	api?: string;
	modelId?: string;
	agentDir?: string;
	entries?: Array<{ type: string; customType?: string; data?: unknown }>;
} = {}) {
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ message: string; level: string }> = [];
	const entries = options.entries ?? [];

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	if (options.agentDir) process.env.PI_CODING_AGENT_DIR = options.agentDir;

	fastExtension({
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry: () => {
			throw new Error("fast should not persist via session entries");
		},
	} as never);

	const ctx = {
		ui: {
			notify(message: string, level = "info") {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
		},
		sessionManager: { getBranch: () => entries },
		model: {
			api: options.api ?? "openai-responses",
			id: options.modelId ?? "gpt-5.6-sol",
		} as { api?: string; id?: string },
	};

	const restoreEnv = () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	};

	return { commands, ctx, handlers, notifications, restoreEnv, statuses };
}

describe("supportsFastApi / isGptModelId / isFastActive / shouldInjectPriority", () => {
	it("accepts openai-family Responses APIs only", () => {
		assert.equal(supportsFastApi("openai-responses"), true);
		assert.equal(supportsFastApi("openai-codex-responses"), true);
		assert.equal(supportsFastApi("azure-openai-responses"), true);
		assert.equal(supportsFastApi("anthropic-messages"), false);
		assert.equal(supportsFastApi(undefined), false);
	});

	it("accepts only GPT model ids", () => {
		assert.equal(isGptModelId("gpt-5.6-sol"), true);
		assert.equal(isGptModelId("GPT-4o"), true);
		assert.equal(isGptModelId("gpt.5"), true);
		assert.equal(isGptModelId("gpt"), true);
		assert.equal(isGptModelId("grok-4.5"), false);
		assert.equal(isGptModelId("claude-opus-4"), false);
		assert.equal(isGptModelId("codex-auto-review"), false);
		assert.equal(isGptModelId("o3-mini"), false);
		assert.equal(isGptModelId(undefined), false);
	});

	it("is active only when preferred, openai-family API, and GPT model", () => {
		assert.equal(supportsFastModel("openai-responses", "gpt-5.6-sol"), true);
		assert.equal(supportsFastModel("openai-responses", "grok-4.5"), false);
		assert.equal(supportsFastModel("anthropic-messages", "gpt-5.6-sol"), false);

		assert.equal(isFastActive(true, "openai-responses", "gpt-5.6-sol"), true);
		assert.equal(isFastActive(true, "openai-responses", "grok-4.5"), false);
		assert.equal(isFastActive(true, "anthropic-messages", "gpt-5"), false);
		assert.equal(isFastActive(false, "openai-responses", "gpt-5"), false);
		assert.equal(isFastActive(true, "openai-responses", undefined), false);
	});

	it("injects only for GPT models on known openai-family APIs", () => {
		assert.equal(shouldInjectPriority(true, "openai-responses", "gpt-5.2"), true);
		assert.equal(shouldInjectPriority(true, "openai-responses", "grok-4.5"), false);
		assert.equal(shouldInjectPriority(true, undefined, "gpt-5.2"), false);
		assert.equal(shouldInjectPriority(true, "anthropic-messages", "gpt-5.2"), false);
		assert.equal(shouldInjectPriority(false, "openai-responses", "gpt-5.2"), false);
	});
});

describe("fast global preference", () => {
	it("loads and saves fast.enabled in terrific.json", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-config-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, JSON.stringify({ mode: { default: "edit" } }), "utf8");
		chmodSync(path, 0o640);

		assert.equal(hasFastPreference(agentDir), false);
		assert.equal(loadFastEnabled(agentDir), false);
		assert.equal(saveFastEnabled(true, agentDir), true);
		assert.equal(hasFastPreference(agentDir), true);
		assert.equal(loadFastEnabled(agentDir), true);

		const saved = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(saved.mode.default, "edit");
		assert.equal(saved.fast.enabled, true);
		assert.equal(statSync(path).mode & 0o777, 0o640);
	});

	it("refuses to overwrite corrupt terrific.json", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-corrupt-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, "{ bad", "utf8");

		assert.equal(loadFastEnabled(agentDir), false);
		assert.equal(hasFastPreference(agentDir), false);
		assert.equal(saveFastEnabled(true, agentDir), false);
		assert.equal(readFileSync(path, "utf8"), "{ bad");
	});

	it("fails save when lock is held", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-lock-"));
		const path = join(agentDir, "terrific.json");
		writeFileSync(path, "{}\n", "utf8");
		writeFileSync(`${path}.lock`, JSON.stringify({ token: "other" }), "utf8");

		assert.equal(saveFastEnabled(true, agentDir), false);
		assert.equal(loadFastEnabled(agentDir), false);
	});

	it("restores preferred state globally and shows badge only on GPT models", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-restore-"));
		saveFastEnabled(true, agentDir);

		const { ctx, handlers, restoreEnv, statuses } = createExtensionHarness({ agentDir });
		try {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
			assert.equal(statuses.get("fast"), "");

			ctx.model.api = "openai-responses";
			ctx.model.id = "grok-4.5";
			for (const handler of handlers.get("model_select") ?? []) {
				await handler({ model: { api: "openai-responses", id: "grok-4.5" }, source: "set" }, ctx);
			}
			assert.equal(statuses.get("fast"), undefined);

			ctx.model.api = "openai-responses";
			ctx.model.id = "gpt-5.6-luna";
			for (const handler of handlers.get("model_select") ?? []) {
				await handler({ model: { api: "openai-responses", id: "gpt-5.6-luna" }, source: "set" }, ctx);
			}
			assert.equal(statuses.get("fast"), "");
		} finally {
			restoreEnv();
		}
	});

	it("hides badge on model_select to non-GPT from event.model (model-profile path)", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-model-select-yield-"));
		saveFastEnabled(true, agentDir);
		const { ctx, handlers, restoreEnv, statuses } = createExtensionHarness({ agentDir });
		try {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
			assert.equal(statuses.get("fast"), "");

			ctx.model.api = "openai-responses";
			ctx.model.id = "grok-4.5";
			for (const handler of handlers.get("model_select") ?? []) {
				await handler({ model: { api: "openai-responses", id: "grok-4.5" }, source: "set" }, ctx);
			}
			assert.equal(statuses.get("fast"), undefined);

			const payload = { model: "grok-4.5" } as { model: string; service_tier?: string };
			for (const handler of handlers.get("before_provider_request") ?? []) {
				handler({ payload }, ctx);
			}
			assert.equal(payload.service_tier, undefined);

			for (const handler of handlers.get("before_agent_start") ?? []) {
				await handler({}, ctx);
			}
			assert.equal(statuses.get("fast"), undefined);
		} finally {
			restoreEnv();
		}
	});

	it("migrates legacy session fast-state when global key is absent", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-migrate-"));
		const { ctx, handlers, restoreEnv, statuses } = createExtensionHarness({
			agentDir,
			entries: [{ type: "custom", customType: "fast-state", data: { enabled: true } }],
		});
		try {
			assert.equal(hasFastPreference(agentDir), false);
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
			assert.equal(statuses.get("fast"), "");
			assert.equal(loadFastEnabled(agentDir), true);
			assert.equal(hasFastPreference(agentDir), true);
		} finally {
			restoreEnv();
		}
	});

	it("does not migrate session state when global key already exists", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-no-migrate-"));
		saveFastEnabled(false, agentDir);

		const { ctx, handlers, restoreEnv, statuses } = createExtensionHarness({
			agentDir,
			entries: [{ type: "custom", customType: "fast-state", data: { enabled: true } }],
		});
		try {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
			assert.equal(statuses.get("fast"), undefined);
			assert.equal(loadFastEnabled(agentDir), false);
		} finally {
			restoreEnv();
		}
	});

	it("persists toggle to terrific.json and keeps preference when inactive", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-toggle-"));
		const { commands, ctx, restoreEnv, statuses } = createExtensionHarness({
			agentDir,
			api: "openai-responses",
			modelId: "grok-4.5",
		});
		try {
			await commands.get("fast")!.handler("on", ctx);
			assert.equal(loadFastEnabled(agentDir), true);
			assert.equal(statuses.get("fast"), undefined);

			await commands.get("fast")!.handler("off", ctx);
			assert.equal(loadFastEnabled(agentDir), false);
		} finally {
			restoreEnv();
		}
	});

	it("rereads external edits before the next provider request", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-live-config-"));
		saveFastEnabled(false, agentDir);
		const { commands, ctx, handlers, notifications, restoreEnv, statuses } = createExtensionHarness({ agentDir });
		try {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
			assert.equal(statuses.get("fast"), undefined);

			saveFastEnabled(true, agentDir);
			for (const handler of handlers.get("before_agent_start") ?? []) await handler({}, ctx);
			const enabled = { model: "gpt-5.6-sol" } as { model: string; service_tier?: string };
			for (const handler of handlers.get("before_provider_request") ?? []) handler({ payload: enabled }, ctx);
			assert.equal(enabled.service_tier, "priority");
			assert.equal(statuses.get("fast"), "");
			await commands.get("fast")!.handler("status", ctx);
			assert.match(notifications.at(-1)?.message ?? "", /Injected \(last provider request\): yes/);

			saveFastEnabled(false, agentDir);
			const disabled = { model: "gpt-5.6-sol" } as { model: string; service_tier?: string };
			for (const handler of handlers.get("before_provider_request") ?? []) handler({ payload: disabled }, ctx);
			assert.equal(disabled.service_tier, undefined);
			assert.equal(statuses.get("fast"), undefined);
			await commands.get("fast")!.handler("status", ctx);
			assert.match(notifications.at(-1)?.message ?? "", /Preferred: off/);
			assert.match(notifications.at(-1)?.message ?? "", /Eligible: yes/);
			assert.match(notifications.at(-1)?.message ?? "", /Injected \(last provider request\): no/);
		} finally {
			restoreEnv();
		}
	});

	it("keeps the file as truth when a command write fails", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-write-failure-"));
		saveFastEnabled(false, agentDir);
		writeFileSync(`${join(agentDir, "terrific.json")}.lock`, JSON.stringify({ token: "other" }), "utf8");
		const { commands, ctx, notifications, restoreEnv, statuses } = createExtensionHarness({ agentDir });
		try {
			await commands.get("fast")!.handler("on", ctx);
			assert.equal(loadFastEnabled(agentDir), false);
			assert.equal(statuses.get("fast"), undefined);
			assert.match(notifications.at(-1)?.message ?? "", /failed to write terrific\.json/i);
		} finally {
			restoreEnv();
		}
	});

	it("injects only for GPT models and skips non-GPT or unknown APIs", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-inject-"));
		saveFastEnabled(true, agentDir);
		const { ctx, handlers, restoreEnv } = createExtensionHarness({ agentDir });
		try {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);

			const payload = { model: "gpt-5.2" };
			for (const handler of handlers.get("before_provider_request") ?? []) {
				handler({ payload }, ctx);
			}
			assert.equal((payload as { service_tier?: string }).service_tier, "priority");

			ctx.model.api = "openai-responses";
			ctx.model.id = "grok-4.5";
			const grok = { model: "grok-4.5" } as { model: string; service_tier?: string };
			for (const handler of handlers.get("before_provider_request") ?? []) {
				handler({ payload: grok }, ctx);
			}
			assert.equal(grok.service_tier, undefined);

			ctx.model.api = "anthropic-messages";
			ctx.model.id = "claude-opus-4";
			const other = { model: "claude" } as { model: string; service_tier?: string };
			for (const handler of handlers.get("before_provider_request") ?? []) {
				handler({ payload: other }, ctx);
			}
			assert.equal(other.service_tier, undefined);

			delete ctx.model.api;
			delete ctx.model.id;
			const unknown = { model: "maybe-openai" } as { model: string; service_tier?: string };
			for (const handler of handlers.get("before_provider_request") ?? []) {
				handler({ payload: unknown }, ctx);
			}
			assert.equal(unknown.service_tier, undefined);
		} finally {
			restoreEnv();
		}
	});
});

describe("readSessionFastState", () => {
	it("reads the latest enabled flag from the branch", () => {
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: "fast-state", data: { enabled: false } },
					{ type: "custom", customType: "fast-state", data: { enabled: true } },
				],
			},
		} as any;
		assert.equal(readSessionFastState(ctx), true);
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
