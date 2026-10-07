import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fastExtension, { saveFastEnabled } from "../extensions/fast.ts";
import { aggregateSessionUsage } from "../../../interface/statusline/lib/usage.ts";

async function withBilling(run: (app: ReturnType<typeof harness>) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "fast-billing-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		saveFastEnabled(true);
		await run(harness());
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

function harness() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	fastExtension({ registerCommand() {}, on(name: string, handler: any) { handlers.set(name, handler); } } as never);
	const ctx = {
		model: { provider: "proxy", id: "gpt-5.4", api: "openai-responses", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
		ui: { setStatus() {} },
	};
	const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	const request = () => emit("before_provider_request", { payload: { model: ctx.model.id } });
	const response = (tier: string) => emit("provider_stream_event", {
		provider: ctx.model.provider, api: ctx.model.api, model: ctx.model.id,
		data: { type: "response.completed", response: { service_tier: tier } },
	});
	const message = (cost = 0) => ({
		role: "assistant", provider: ctx.model.provider, model: ctx.model.id, api: ctx.model.api,
		content: [], timestamp: 1, stopReason: "stop",
		usage: { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 100_000, totalTokens: 2_200_000,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
	});
	const finish = async (original = message()) => (await emit("message_end", { message: original }))?.message ?? original;
	return { ctx, emit, request, response, message, finish };
}

test("persists per-request Fast pricing across toggles, reloads, and rate changes without double charging", async () => {
	await withBilling(async (app) => {
		await app.request();
		// Toggle after dispatch: the in-flight request is still priority.
		saveFastEnabled(false);
		await app.response("priority");
		const original = app.message(6.9); // The native provider already applied 2x.
		const before = structuredClone(original);
		const fast = await app.finish(original);
		assert.ok(Math.abs(fast.usage.cost.total - 6.9) < 1e-9);
		assert.equal(fast.terrificFastPricing.multiplier, 2);
		assert.equal(fast.terrificFastPricing.source, "response");
		assert.deepEqual(original, before);
		await app.request();
		const normal = await app.finish();
		assert.equal(normal.terrificFastPricing.multiplier, 1);
		const entries = JSON.parse(JSON.stringify([fast, normal].map(message => ({ type: "message", message }))));
		const model = app.ctx.model as any;
		assert.ok(Math.abs(aggregateSessionUsage(entries, () => model).cost - 10.35) < 1e-9);
		model.cost = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };
		assert.ok(Math.abs(aggregateSessionUsage(entries, () => model).cost - 20.7) < 1e-9);
		assert.ok(Math.abs(aggregateSessionUsage(entries, () => undefined).cost - 10.35) < 1e-9);
	});
});

test("uses response tier over requested priority, including downgrade and flex", async () => {
	await withBilling(async (app) => {
		for (const [tier, multiplier] of [["default", 1], ["flex", 0.5], ["priority", 2], ["fast", 2]] as const) {
			await app.request();
			await app.response(tier);
			const result = await app.finish();
			assert.equal(result.terrificFastPricing.multiplier, multiplier);
			assert.ok(Math.abs(result.usage.cost.total - 3.45 * multiplier) < 1e-9);
		}
	});
});

test("estimates missing response evidence from the request and preserves zero-price provenance", async () => {
	await withBilling(async (app) => {
		app.ctx.model.id = "gpt-5.5";
		await app.request();
		const result = await app.finish();
		assert.equal(result.terrificFastPricing.multiplier, 2.5);
		assert.equal(result.terrificFastPricing.source, "request");
		app.ctx.model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		await app.request();
		const zero = await app.finish();
		assert.equal(zero.usage.cost.total, 0);
		assert.equal(zero.terrificFastPricing.multiplier, 2.5);
		const repriced = aggregateSessionUsage([{ type: "message", message: zero }], () => ({ ...app.ctx.model, cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 } }) as any);
		assert.equal(repriced.cost, 5);
	});
});

test("retries reset response evidence and unrelated provider events cannot change billing", async () => {
	await withBilling(async (app) => {
		await app.request();
		await app.response("default");
		await app.request(); // Retry has its own service tier evidence.
		await app.emit("provider_stream_event", { provider: "other", api: "openai-responses", model: "gpt-5.4", data: { response: { service_tier: "default" } } });
		assert.equal((await app.finish()).terrificFastPricing.multiplier, 2);
		assert.equal((await app.finish()).terrificFastPricing, undefined);
		await app.request();
		await app.emit("session_tree");
		assert.equal((await app.finish()).terrificFastPricing, undefined);
	});
});

test("matches Codex default-tier fallback and snapshots request rates until the message ends", async () => {
	await withBilling(async (app) => {
		app.ctx.model.api = "openai-codex-responses";
		await app.request();
		await app.response("default");
		app.ctx.model.cost.input = 100;
		const result = await app.finish();
		assert.equal(result.terrificFastPricing.multiplier, 2);
		assert.equal(result.terrificFastPricing.source, "request");
		assert.ok(Math.abs(result.usage.cost.total - 6.9) < 1e-9);
	});
});

test("bills reported partial usage on abort but clears evidence before the next run", async () => {
	await withBilling(async (app) => {
		await app.request();
		const aborted = { ...app.message(), stopReason: "aborted" };
		assert.ok(Math.abs((await app.finish(aborted)).usage.cost.total - 6.9) < 1e-9);
		await app.request();
		await app.emit("agent_end");
		assert.equal((await app.finish()).terrificFastPricing, undefined);
		await app.request();
		await app.emit("session_shutdown");
		assert.equal((await app.finish()).terrificFastPricing, undefined);
	});
});

test("does not bill ineligible models or guess Fast status for historical messages", async () => {
	await withBilling(async (app) => {
		app.ctx.model.id = "grok-4";
		await app.request();
		const original = app.message(7);
		assert.equal(await app.finish(original), original);
		const history = [{ type: "message", message: app.message(7) }];
		assert.ok(Math.abs(aggregateSessionUsage(history, () => app.ctx.model as any).cost - 3.45) < 1e-9);
	});
});
