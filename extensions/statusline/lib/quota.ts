import type { QuotaProvider, QuotaSnapshot, QuotaWindow } from "./types.ts";
import { formatQuotaWindowLabel } from "./format.ts";

export const QUOTA_TTL_MS = 5 * 60_000;
export const QUOTA_TIMEOUT_MS = 8_000;
export const QUOTA_COUNTDOWN_MS = 60_000;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CLAUDE_BASE_URL = "https://api.anthropic.com";

export type ModelLike = {
	id?: string;
	name?: string;
	provider?: string;
	api?: string;
	baseUrl?: string;
};

export type ModelRegistryLike = {
	isUsingOAuth(model: ModelLike): boolean;
	getRegisteredProviderConfig?(providerName: string): unknown | undefined;
	getApiKeyAndHeaders(model: ModelLike): Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string> }
		| { ok: false; error: string }
	>;
};

export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		signal?: AbortSignal;
		redirect?: RequestRedirect;
	},
) => Promise<{
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	json(): Promise<unknown>;
	text(): Promise<string>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeUrl(url: string | undefined): string {
	if (!url) return "";
	try {
		const parsed = new URL(url);
		const path = parsed.pathname.replace(/\/+$/, "");
		return `${parsed.protocol}//${parsed.host}${path}`;
	} catch {
		return url.replace(/\/+$/, "");
	}
}

export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	// Round to 3 decimals to kill float noise from 0..1 utilization scaling.
	const rounded = Math.round(value * 1000) / 1000;
	return Math.max(0, Math.min(100, rounded));
}

export function parseResetAt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		// seconds vs ms heuristic
		return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
	}
	if (typeof value === "string" && value.trim()) {
		const asNumber = Number(value);
		if (Number.isFinite(asNumber)) return parseResetAt(asNumber);
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}

export function extractUtilizationPercent(raw: unknown): number | undefined {
	if (!isRecord(raw)) return undefined;
	const candidates = [
		raw.used_percent,
		raw.usedPercent,
		raw.utilization,
		raw.utilization_percent,
		raw.percent_used,
		raw.percentage,
	];
	for (const candidate of candidates) {
		if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
		// utilization may be 0..1 or 0..100
		if (candidate >= 0 && candidate <= 1) return clampPercent(candidate * 100);
		return clampPercent(candidate);
	}
	if (typeof raw.remaining_percent === "number" && Number.isFinite(raw.remaining_percent)) {
		return clampPercent(100 - raw.remaining_percent);
	}
	if (typeof raw.remaining === "number" && typeof raw.limit === "number" && raw.limit > 0) {
		return clampPercent(((raw.limit - raw.remaining) / raw.limit) * 100);
	}
	return undefined;
}

export function extractChatGptAccountId(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length < 2) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
		if (!isRecord(payload)) return undefined;
		const auth = payload["https://api.openai.com/auth"];
		if (isRecord(auth) && typeof auth.chatgpt_account_id === "string") {
			return auth.chatgpt_account_id;
		}
		if (typeof payload.chatgpt_account_id === "string") return payload.chatgpt_account_id;
	} catch {
		return undefined;
	}
	return undefined;
}

export function resolveNativeQuotaProvider(
	model: ModelLike | undefined,
	registry: Pick<ModelRegistryLike, "isUsingOAuth" | "getRegisteredProviderConfig">,
): QuotaProvider | undefined {
	if (!model?.provider || !model.api) return undefined;
	if (!registry.isUsingOAuth(model)) return undefined;
	if (registry.getRegisteredProviderConfig?.(model.provider)) return undefined;

	const base = normalizeUrl(model.baseUrl);

	if (
		model.provider === "openai-codex"
		&& model.api === "openai-codex-responses"
		&& base === CODEX_BASE_URL
	) {
		return "codex";
	}

	if (
		model.provider === "anthropic"
		&& model.api === "anthropic-messages"
		&& base === CLAUDE_BASE_URL
	) {
		return "claude";
	}

	return undefined;
}

function windowFromRaw(
	id: string,
	fallbackLabel: string,
	raw: unknown,
): QuotaWindow | undefined {
	if (!isRecord(raw)) return undefined;
	const usedPercent = extractUtilizationPercent(raw);
	if (usedPercent === undefined) return undefined;
	const windowSeconds = typeof raw.limit_window_seconds === "number"
		? raw.limit_window_seconds
		: typeof raw.window_seconds === "number"
			? raw.window_seconds
			: undefined;
	const resetsAt = parseResetAt(raw.reset_at ?? raw.resets_at ?? raw.resetAt ?? raw.resetsAt);
	return {
		id,
		label: formatQuotaWindowLabel(windowSeconds, fallbackLabel),
		usedPercent,
		resetsAt,
		windowSeconds,
	};
}

function normalizeModelKey(value: string | undefined): string {
	return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function modelMatchesBucket(model: ModelLike, raw: Record<string, unknown>): boolean {
	const keys = [
		raw.metered_feature,
		raw.limit_name,
		raw.model,
		raw.model_name,
		raw.feature,
	]
		.filter((item): item is string => typeof item === "string")
		.map(normalizeModelKey)
		.filter(Boolean);
	if (keys.length === 0) return false;
	const modelKeys = [model.id, model.name].map(normalizeModelKey).filter(Boolean);
	return keys.some((key) => modelKeys.some((modelKey) => modelKey.includes(key) || key.includes(modelKey)));
}

export function parseCodexUsage(payload: unknown, model: ModelLike = {}): QuotaSnapshot | undefined {
	if (!isRecord(payload)) return undefined;
	const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : payload;
	const windows: QuotaWindow[] = [];

	const primary = windowFromRaw("primary", "5h", rateLimit.primary_window);
	if (primary) windows.push(primary);
	const secondary = windowFromRaw("secondary", "7d", rateLimit.secondary_window);
	if (secondary) windows.push(secondary);

	let modelBucket: string | undefined;
	const additional = Array.isArray(payload.additional_rate_limits)
		? payload.additional_rate_limits
		: Array.isArray(rateLimit.additional_rate_limits)
			? rateLimit.additional_rate_limits
			: [];

	const matched: QuotaWindow[] = [];
	for (const [index, item] of additional.entries()) {
		if (!isRecord(item)) continue;
		const parsed = windowFromRaw(
			`extra-${index}`,
			typeof item.limit_name === "string" ? item.limit_name : `extra${index + 1}`,
			item,
		);
		if (!parsed) continue;
		if (modelMatchesBucket(model, item)) {
			matched.push(parsed);
			modelBucket = parsed.label;
		}
	}

	// Unique model bucket replaces defaults; otherwise keep primary/secondary.
	const finalWindows = matched.length === 1 ? matched : windows;
	if (finalWindows.length === 0) return undefined;

	return {
		provider: "codex",
		modelBucket,
		windows: finalWindows,
		capturedAt: Date.now(),
		stale: false,
	};
}

function claudeWindow(id: string, label: string, raw: unknown): QuotaWindow | undefined {
	const window = windowFromRaw(id, label, raw);
	return window;
}

export function parseClaudeUsage(payload: unknown, model: ModelLike = {}): QuotaSnapshot | undefined {
	if (!isRecord(payload)) return undefined;
	const windows: QuotaWindow[] = [];

	const fiveHour = claudeWindow("five_hour", "5h", payload.five_hour);
	if (fiveHour) windows.push(fiveHour);

	const modelKey = normalizeModelKey(model.id ?? model.name);
	const sonnet = claudeWindow("seven_day_sonnet", "Sonnet 7d", payload.seven_day_sonnet);
	const opus = claudeWindow("seven_day_opus", "Opus 7d", payload.seven_day_opus);
	const sevenDay = claudeWindow("seven_day", "7d", payload.seven_day);

	if (modelKey.includes("opus") && opus) windows.push(opus);
	else if (modelKey.includes("sonnet") && sonnet) windows.push(sonnet);
	else if (sevenDay) windows.push(sevenDay);
	else {
		if (sonnet) windows.push(sonnet);
		if (opus) windows.push(opus);
	}

	const extra = claudeWindow("extra_usage", "Extra", payload.extra_usage);
	if (extra) windows.push(extra);

	// Enterprise / other budget windows with clear utilization structure.
	for (const [key, value] of Object.entries(payload)) {
		if (
			key === "five_hour"
			|| key === "seven_day"
			|| key === "seven_day_sonnet"
			|| key === "seven_day_opus"
			|| key === "extra_usage"
		) {
			continue;
		}
		const parsed = claudeWindow(key, key, value);
		if (parsed) windows.push(parsed);
	}

	if (windows.length === 0) return undefined;
	return {
		provider: "claude",
		windows,
		capturedAt: Date.now(),
		stale: false,
	};
}

function authHeaders(
	auth: { apiKey?: string; headers?: Record<string, string> },
	provider: QuotaProvider,
): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": "terrific-pi-statusline",
		...(auth.headers ?? {}),
	};
	if (!headers.Authorization && !headers.authorization && auth.apiKey) {
		headers.Authorization = `Bearer ${auth.apiKey}`;
	}
	if (provider === "claude") {
		headers["anthropic-beta"] = headers["anthropic-beta"] ?? "oauth-2025-04-20";
	}
	if (provider === "codex") {
		const token = auth.apiKey
			?? headers.Authorization?.replace(/^Bearer\s+/i, "")
			?? headers.authorization?.replace(/^Bearer\s+/i, "");
		const accountId = extractChatGptAccountId(token);
		if (accountId && !headers["ChatGPT-Account-Id"] && !headers["chatgpt-account-id"]) {
			headers["ChatGPT-Account-Id"] = accountId;
		}
	}
	return headers;
}

function looksLikeStaleZero(previous: QuotaSnapshot | undefined, next: QuotaSnapshot): boolean {
	if (!previous || previous.provider !== "codex" || next.provider !== "codex") return false;
	const prevPrimary = previous.windows.find((window) => window.id === "primary") ?? previous.windows[0];
	const nextPrimary = next.windows.find((window) => window.id === "primary") ?? next.windows[0];
	if (!prevPrimary || !nextPrimary) return false;
	const prevRemaining = 100 - prevPrimary.usedPercent;
	const nextRemaining = 100 - nextPrimary.usedPercent;
	if (prevRemaining < 50 || nextRemaining > 5) return false;
	// reset window unchanged or just rolled
	if (
		prevPrimary.resetsAt !== undefined
		&& nextPrimary.resetsAt !== undefined
		&& nextPrimary.resetsAt < prevPrimary.resetsAt
	) {
		return false;
	}
	return true;
}

export class QuotaMonitor {
	private snapshot: QuotaSnapshot | undefined;
	private provider: QuotaProvider | undefined;
	private inflight: Promise<void> | undefined;
	private abort: AbortController | undefined;
	private backoffUntil = 0;
	private pendingZero: QuotaSnapshot | undefined;
	private countdownTimer: ReturnType<typeof setInterval> | undefined;
	private generation = 0;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private readonly onChange: () => void;

	constructor(options?: {
		fetchImpl?: FetchLike;
		now?: () => number;
		onChange?: () => void;
	}) {
		this.fetchImpl = options?.fetchImpl ?? (globalThis.fetch as FetchLike);
		this.now = options?.now ?? Date.now;
		this.onChange = options?.onChange ?? (() => {});
	}

	getSnapshot(): QuotaSnapshot | undefined {
		if (!this.snapshot) return undefined;
		const now = this.now();
		const windows = this.snapshot.windows.filter(
			(window) => window.resetsAt === undefined || window.resetsAt > now,
		);
		if (windows.length === 0) return undefined;
		if (windows.length !== this.snapshot.windows.length) {
			return { ...this.snapshot, windows };
		}
		return this.snapshot;
	}

	clear(): void {
		this.snapshot = undefined;
		this.provider = undefined;
		this.pendingZero = undefined;
		this.backoffUntil = 0;
		this.abort?.abort();
		this.abort = undefined;
		this.inflight = undefined;
		this.stopCountdown();
		this.onChange();
	}

	dispose(): void {
		this.generation += 1;
		this.clear();
	}

	private stopCountdown(): void {
		if (this.countdownTimer) {
			clearInterval(this.countdownTimer);
			this.countdownTimer = undefined;
		}
	}

	private startCountdown(): void {
		if (this.countdownTimer) return;
		this.countdownTimer = setInterval(() => {
			const snap = this.getSnapshot();
			if (!snap) {
				this.stopCountdown();
				this.snapshot = undefined;
				this.onChange();
				return;
			}
			// countdown-only re-render; no network
			this.onChange();
		}, QUOTA_COUNTDOWN_MS);
	}

	async sync(
		model: ModelLike | undefined,
		registry: ModelRegistryLike,
		enabled: boolean,
	): Promise<void> {
		if (!enabled) {
			if (this.snapshot) this.clear();
			return;
		}

		const provider = resolveNativeQuotaProvider(model, registry);
		if (!provider) {
			if (this.snapshot) this.clear();
			return;
		}

		if (this.provider && this.provider !== provider) {
			this.snapshot = undefined;
			this.pendingZero = undefined;
		}
		this.provider = provider;

		const now = this.now();
		if (now < this.backoffUntil) return;
		if (
			this.snapshot
			&& this.snapshot.provider === provider
			&& !this.snapshot.stale
			&& now - this.snapshot.capturedAt < QUOTA_TTL_MS
		) {
			this.startCountdown();
			return;
		}

		if (this.inflight) {
			await this.inflight;
			return;
		}

		const generation = this.generation;
		this.inflight = this.refresh(model!, registry, provider, generation).finally(() => {
			this.inflight = undefined;
		});
		await this.inflight;
	}

	noteProviderResponse(status: number, headers: Record<string, string>): void {
		if (status !== 429) return;
		const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
		const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN;
		const delayMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;
		this.backoffUntil = this.now() + delayMs;
		if (this.snapshot) {
			this.snapshot = { ...this.snapshot, stale: true };
			this.onChange();
		}
	}

	private async refresh(
		model: ModelLike,
		registry: ModelRegistryLike,
		provider: QuotaProvider,
		generation: number,
	): Promise<void> {
		this.abort?.abort();
		const abort = new AbortController();
		this.abort = abort;
		const timeout = setTimeout(() => abort.abort(), QUOTA_TIMEOUT_MS);

		try {
			let auth = await registry.getApiKeyAndHeaders(model);
			if (!auth.ok) return;
			let response = await this.request(provider, auth, abort.signal);
			if ((response.status === 401 || response.status === 403) && generation === this.generation) {
				auth = await registry.getApiKeyAndHeaders(model);
				if (!auth.ok) return;
				response = await this.request(provider, auth, abort.signal);
			}
			if (generation !== this.generation) return;

			if (response.status === 429) {
				const retryAfter = response.headers.get("retry-after");
				this.noteProviderResponse(429, retryAfter ? { "retry-after": retryAfter } : {});
				return;
			}
			if (!response.ok) {
				if (this.snapshot) {
					this.snapshot = { ...this.snapshot, stale: true };
					this.onChange();
				}
				return;
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				return;
			}

			const parsed = provider === "codex"
				? parseCodexUsage(payload, model)
				: parseClaudeUsage(payload, model);
			if (!parsed) return;

			const codexHealthy = provider !== "codex" || (
				isRecord(payload)
				&& payload.allowed !== false
				&& payload.limit_reached !== true
			);
			if (codexHealthy && looksLikeStaleZero(this.snapshot, parsed)) {
				if (!this.pendingZero) {
					this.pendingZero = parsed;
					return;
				}
				// second near-zero sample accepts
				this.pendingZero = undefined;
			} else {
				this.pendingZero = undefined;
			}

			this.snapshot = parsed;
			this.startCountdown();
			this.onChange();
		} catch {
			if (generation !== this.generation) return;
			if (this.snapshot) {
				this.snapshot = { ...this.snapshot, stale: true };
				this.onChange();
			}
		} finally {
			clearTimeout(timeout);
			if (this.abort === abort) this.abort = undefined;
		}
	}

	private async request(
		provider: QuotaProvider,
		auth: { ok: true; apiKey?: string; headers?: Record<string, string> },
		signal: AbortSignal,
	) {
		const url = provider === "codex" ? CODEX_USAGE_URL : CLAUDE_USAGE_URL;
		return this.fetchImpl(url, {
			method: "GET",
			headers: authHeaders(auth, provider),
			signal,
			redirect: "error",
		});
	}
}
