import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import fastExtension, {
	hasFastPreference,
	injectPriority,
	isFastActive,
	loadFastEnabled,
	readSessionFastState,
	saveFastEnabled,
	shouldInjectPriority,
	supportsFastApi,
} from "../extensions/fast.ts";

function createExtensionHarness(options: {
	api?: string;
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
		model: { api: options.api ?? "openai-responses" } as { api?: string },
	};

	const restoreEnv = () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	};

	return { commands, ctx, handlers, notifications, restoreEnv, statuses };
}

describe("supportsFastApi / isFastActive / shouldInjectPriority", () => {
	it("accepts openai-family Responses APIs only", () => {
		assert.equal(supportsFastApi("openai-responses"), true);
		assert.equal(supportsFastApi("openai-codex-responses"), true);
		assert.equal(supportsFastApi("azure-openai-responses"), true);
		assert.equal(supportsFastApi("anthropic-messages"), false);
		assert.equal(supportsFastApi(undefined), false);
	});

	it("is active only when preferred and openai-family", () => {
		assert.equal(isFastActive(true, "openai-responses"), true);
		assert.equal(isFastActive(true, "anthropic-messages"), false);
		assert.equal(isFastActive(false, "openai-responses"), false);
		assert.equal(isFastActive(true, undefined), false);
	});

	it("injects when preferred and API unknown, skips known non-openai", () => {
		assert.equal(shouldInjectPriority(true, "openai-responses"), true);
		assert.equal(shouldInjectPriority(true, undefined), true);
		assert.equal(shouldInjectPriority(true, "anthropic-messages"), false);
		assert.equal(shouldInjectPriority(false, undefined), false);
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

	it("restores preferred state globally and shows badge only on openai models", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "fast-restore-"));
		saveFastEnabled(true, agentDir);

		const { ctx, handlers, restoreEnv, statuses } = createExtensionHarness({ agentDir });
		try {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
			assert.equal(statuses.get("fast"), "");

			ctx.model.api = "anthropic-messages";
			for (const handler of handlers.get("model_select") ?? []) {
				await handler({ model: { api: "anthropic-messages" }, source: "set" }, ctx);
			}
			assert.equal(statuses.get("fast"), undefined);

			ctx.model.api = "openai-responses";
			for (const handler of handlers.get("model_select") ?? []) {
				await handler({ model: { api: "openai-responses" }, source: "set" }, ctx);
			}
			assert.equal(statuses.get("fast"), "");
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
			api: "anthropic-messages",
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

	it("injects on openai, skips known non-openai, still injects when model api missing", async () => {
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

			ctx.model.api = "anthropic-messages";
			const other = { model: "claude" } as { model: string; service_tier?: string };
			for (const handler of handlers.get("before_provider_request") ?? []) {
				handler({ payload: other }, ctx);
			}
			assert.equal(other.service_tier, undefined);

			// Unknown/missing model must not silently drop priority when preferred.
			delete ctx.model.api;
			const unknown = { model: "maybe-openai" } as { model: string; service_tier?: string };
			for (const handler of handlers.get("before_provider_request") ?? []) {
				handler({ payload: unknown }, ctx);
			}
			assert.equal(unknown.service_tier, "priority");
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
