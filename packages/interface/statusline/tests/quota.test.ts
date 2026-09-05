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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function response(payload: unknown) {
	return {
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () => payload,
		text: async () => "",
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 20 && !predicate(); index += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal(predicate(), true, "condition was not reached");
}

function registry(options: {
	oauth?: boolean;
	override?: boolean;
	auth?: { ok: true; apiKey?: string; headers?: Record<string, string | null> } | { ok: false; error: string };
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

	it("exposes loading and first-load error states", async (t) => {
		const pending = deferred<ReturnType<typeof response>>();
		let calls = 0;
		const monitor = new QuotaMonitor({
			fetchImpl: async () => {
				calls += 1;
				return pending.promise;
			},
		});
		t.after(() => monitor.dispose());

		const sync = monitor.sync(codexModel, registry({ oauth: true }), true);
		await waitFor(() => calls === 1);
		assert.equal(monitor.getStatus(), "loading");
		pending.resolve({
			ok: false,
			status: 500,
			headers: { get: () => null },
			json: async () => ({}),
			text: async () => "",
		});
		await sync;
		assert.equal(monitor.getStatus(), "error");
	});

	it("ignores provider 429 before an eligible quota provider is active", () => {
		const monitor = new QuotaMonitor();
		monitor.noteProviderResponse(429, { "retry-after": "60" });
		assert.equal(monitor.getStatus(), "idle");
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

	it("ignores an old provider request after clear and model switch", async (t) => {
		const codexResponse = deferred<ReturnType<typeof response>>();
		const claudeResponse = deferred<ReturnType<typeof response>>();
		let codexStarted = false;
		const fetchImpl = (url: string) => {
			if (url.includes("chatgpt")) {
				codexStarted = true;
				return codexResponse.promise;
			}
			return claudeResponse.promise;
		};
		const monitor = new QuotaMonitor({ fetchImpl });
		t.after(() => monitor.dispose());

		const oldSync = monitor.sync(codexModel, registry({ oauth: true }), true);
		await waitFor(() => codexStarted);
		monitor.clear();
		const newSync = monitor.sync(claudeModel, registry({ oauth: true }), true);
		claudeResponse.resolve(response({ five_hour: { utilization: 0.2 } }));
		await newSync;
		assert.equal(monitor.getSnapshot()?.provider, "claude");

		codexResponse.resolve(response({
			rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 18_000 } },
		}));
		await oldSync;
		assert.equal(monitor.getSnapshot()?.provider, "claude");
	});

	it("invalidates an in-flight request when quota is disabled", async (t) => {
		const pending = deferred<ReturnType<typeof response>>();
		let calls = 0;
		const monitor = new QuotaMonitor({
			fetchImpl: async () => {
				calls += 1;
				return pending.promise;
			},
		});
		t.after(() => monitor.dispose());
		const sync = monitor.sync(codexModel, registry({ oauth: true }), true);
		await waitFor(() => calls === 1);
		await monitor.sync(codexModel, registry({ oauth: true }), false);
		pending.resolve(response({
			rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } },
		}));
		await sync;
		assert.equal(monitor.getSnapshot(), undefined);
	});

	it("does not fetch in PI_OFFLINE mode", async (t) => {
		const previous = process.env.PI_OFFLINE;
		let calls = 0;
		try {
			process.env.PI_OFFLINE = "1";
			const monitor = new QuotaMonitor({
				fetchImpl: async () => {
					calls += 1;
					return response({});
				},
			});
			t.after(() => monitor.dispose());
			await monitor.sync(codexModel, registry({ oauth: true }), true);
			assert.equal(calls, 0);
		} finally {
			if (previous === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previous;
		}
	});

	it("forwards only quota authentication headers", async (t) => {
		let sentHeaders: Record<string, string> | undefined;
		const monitor = new QuotaMonitor({
			fetchImpl: async (_url, init) => {
				sentHeaders = init?.headers;
				return response({ five_hour: { utilization: 0.2 } });
			},
		});
		t.after(() => monitor.dispose());
		await monitor.sync(claudeModel, registry({
			oauth: true,
			auth: {
				ok: true,
				headers: {
					Authorization: "Bearer oauth-token",
					"anthropic-beta": "oauth-2025-04-20",
					"chatgpt-account-id": null,
					"X-Private-Provider-Header": "must-not-leak",
				},
			},
		}), true);
		assert.equal(sentHeaders?.Authorization, "Bearer oauth-token");
		assert.equal(sentHeaders?.["anthropic-beta"], "oauth-2025-04-20");
		assert.equal(sentHeaders?.["chatgpt-account-id"], undefined);
		assert.equal(sentHeaders?.["X-Private-Provider-Header"], undefined);
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
