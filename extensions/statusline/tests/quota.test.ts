import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	extractChatGptAccountId,
	parseClaudeUsage,
	parseCodexUsage,
	QuotaMonitor,
	resolveNativeQuotaProvider,
} from "../lib/quota.ts";

const codexModel = {
	id: "gpt-5",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};

const claudeModel = {
	id: "claude-sonnet-4",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
};

function registry(options: {
	oauth?: boolean;
	override?: boolean;
	auth?: { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string };
}) {
	return {
		isUsingOAuth: () => options.oauth ?? true,
		getRegisteredProviderConfig: () => (options.override ? { baseUrl: "x" } : undefined),
		getApiKeyAndHeaders: async () => options.auth ?? { ok: true as const, apiKey: "token" },
	};
}

describe("resolveNativeQuotaProvider", () => {
	it("accepts official codex and claude oauth models only", () => {
		const reg = registry({ oauth: true });
		assert.equal(resolveNativeQuotaProvider(codexModel, reg), "codex");
		assert.equal(resolveNativeQuotaProvider(claudeModel, reg), "claude");
	});

	it("rejects api key, custom providers, proxy baseUrl, and overrides", () => {
		assert.equal(resolveNativeQuotaProvider(codexModel, registry({ oauth: false })), undefined);
		assert.equal(
			resolveNativeQuotaProvider(
				{ ...codexModel, baseUrl: "https://proxy.example/backend-api" },
				registry({ oauth: true }),
			),
			undefined,
		);
		assert.equal(
			resolveNativeQuotaProvider(
				{ id: "claude", provider: "fable", api: "openai-completions", baseUrl: "https://x" },
				registry({ oauth: true }),
			),
			undefined,
		);
		assert.equal(resolveNativeQuotaProvider(codexModel, registry({ oauth: true, override: true })), undefined);
		assert.equal(
			resolveNativeQuotaProvider(
				{ ...claudeModel, provider: "openai", api: "openai-completions" },
				registry({ oauth: true }),
			),
			undefined,
		);
	});
});

describe("parseCodexUsage", () => {
	it("parses primary and secondary windows", () => {
		const snap = parseCodexUsage({
			rate_limit: {
				primary_window: { used_percent: 7, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
				secondary_window: { used_percent: 33, limit_window_seconds: 604_800 },
			},
			allowed: true,
			limit_reached: false,
		});
		assert.ok(snap);
		assert.equal(snap!.provider, "codex");
		assert.equal(snap!.windows.length, 2);
		assert.equal(snap!.windows[0]!.label, "5h");
		assert.equal(snap!.windows[0]!.usedPercent, 7);
		assert.equal(snap!.windows[1]!.label, "7d");
	});

	it("uses a unique model bucket when matched", () => {
		const snap = parseCodexUsage(
			{
				rate_limit: {
					primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
				},
				additional_rate_limits: [
					{ limit_name: "spark", used_percent: 55, limit_window_seconds: 18_000 },
				],
			},
			{ id: "gpt-spark", name: "spark" },
		);
		assert.ok(snap);
		assert.equal(snap!.windows.length, 1);
		assert.equal(snap!.windows[0]!.usedPercent, 55);
	});

	it("keeps primary window when an extra bucket is corrupt", () => {
		const snap = parseCodexUsage({
			rate_limit: {
				primary_window: { used_percent: 12, limit_window_seconds: 18_000 },
			},
			additional_rate_limits: [{ limit_name: "broken" }],
		});
		assert.ok(snap);
		assert.equal(snap!.windows.length, 1);
		assert.equal(snap!.windows[0]!.usedPercent, 12);
	});
});

describe("parseClaudeUsage", () => {
	it("parses five hour seven day and extra", () => {
		const snap = parseClaudeUsage({
			five_hour: { utilization: 0.07, resets_at: "2030-01-01T00:00:00Z" },
			seven_day: { utilization: 0.33 },
			extra_usage: { utilization: 0.1 },
		});
		assert.ok(snap);
		assert.equal(snap!.windows.map((window) => window.label).join(","), "5h,7d,Extra");
		assert.equal(snap!.windows[0]!.usedPercent, 7);
	});

	it("prefers sonnet weekly window for sonnet models", () => {
		const snap = parseClaudeUsage(
			{
				five_hour: { utilization: 10 },
				seven_day: { utilization: 20 },
				seven_day_sonnet: { utilization: 40 },
			},
			{ id: "claude-sonnet-4" },
		);
		assert.ok(snap);
		assert.equal(snap!.windows.some((window) => window.label === "Sonnet 7d"), true);
		assert.equal(snap!.windows.some((window) => window.label === "7d"), false);
	});
});

describe("extractChatGptAccountId", () => {
	it("reads chatgpt_account_id claim", () => {
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } }),
		).toString("base64url");
		const token = `aaa.${payload}.bbb`;
		assert.equal(extractChatGptAccountId(token), "acct_1");
	});
});

describe("QuotaMonitor", () => {
	it("fetches once and caches within TTL", async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return {
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: async () => ({
					rate_limit: {
						primary_window: { used_percent: 11, limit_window_seconds: 18_000 },
					},
				}),
				text: async () => "",
			};
		};
		const monitor = new QuotaMonitor({ fetchImpl });
		await monitor.sync(codexModel, registry({ oauth: true }), true);
		await monitor.sync(codexModel, registry({ oauth: true }), true);
		assert.equal(calls, 1);
		assert.equal(monitor.getSnapshot()?.windows[0]?.usedPercent, 11);
		monitor.dispose();
	});

	it("hides and skips network when gate fails", async () => {
		let calls = 0;
		const monitor = new QuotaMonitor({
			fetchImpl: async () => {
				calls += 1;
				throw new Error("should not fetch");
			},
		});
		await monitor.sync(codexModel, registry({ oauth: false }), true);
		assert.equal(calls, 0);
		assert.equal(monitor.getSnapshot(), undefined);
		monitor.dispose();
	});

	it("marks stale on 429 and applies backoff", async () => {
		let calls = 0;
		const monitor = new QuotaMonitor({
			fetchImpl: async () => {
				calls += 1;
				if (calls === 1) {
					return {
						ok: true,
						status: 200,
						headers: { get: () => null },
						json: async () => ({
							rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
						}),
						text: async () => "",
					};
				}
				return {
					ok: false,
					status: 429,
					headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? "120" : null) },
					json: async () => ({}),
					text: async () => "",
				};
			},
		});
		await monitor.sync(codexModel, registry({ oauth: true }), true);
		// force refresh by clearing TTL via note + second sync after marking snapshot old
		const snap = monitor.getSnapshot();
		assert.ok(snap);
		(snap as { capturedAt: number }).capturedAt = 0;
		await monitor.sync(codexModel, registry({ oauth: true }), true);
		assert.equal(monitor.getSnapshot()?.stale, true);
		const before = calls;
		await monitor.sync(codexModel, registry({ oauth: true }), true);
		assert.equal(calls, before); // backoff suppresses another request
		monitor.dispose();
	});

	it("requires two near-zero samples before accepting stale-zero", async () => {
		let calls = 0;
		const monitor = new QuotaMonitor({
			fetchImpl: async () => {
				calls += 1;
				const used = calls === 1 ? 10 : 97; // remaining 90% then 3%
				return {
					ok: true,
					status: 200,
					headers: { get: () => null },
					json: async () => ({
						rate_limit: {
							primary_window: {
								used_percent: used,
								limit_window_seconds: 18_000,
								reset_at: 2_000_000_000,
							},
						},
						allowed: true,
						limit_reached: false,
					}),
					text: async () => "",
				};
			},
		});
		await monitor.sync(codexModel, registry({ oauth: true }), true);
		assert.equal(monitor.getSnapshot()?.windows[0]?.usedPercent, 10);
		const snap = monitor.getSnapshot()!;
		(snap as { capturedAt: number }).capturedAt = 0;
		await monitor.sync(codexModel, registry({ oauth: true }), true);
		// first near-zero rejected
		assert.equal(monitor.getSnapshot()?.windows[0]?.usedPercent, 10);
		(snap as { capturedAt: number }).capturedAt = 0;
		await monitor.sync(codexModel, registry({ oauth: true }), true);
		assert.equal(monitor.getSnapshot()?.windows[0]?.usedPercent, 97);
		monitor.dispose();
	});
});
