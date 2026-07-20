/**
 * /fast — toggle OpenAI Priority processing (service_tier: priority).
 *
 * Preference is global (terrific.json) and persists across sessions.
 * Effective only for openai-family Responses APIs; non-openai models auto-yield.
 *
 * Usage:
 *   /fast          toggle
 *   /fast on|off   set explicitly
 */
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FAST_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);
const FAST_STATUS = "";
const FAST_ENTRY_TYPE = "fast-state";

/** Pure helper — inject service_tier into a provider payload object. */
export function injectPriority(payload: unknown): unknown | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const body = payload as Record<string, unknown>;
	// Mutate in place so callers that ignore the return still see the field
	// (event.payload shares the original params reference in pi-ai).
	body.service_tier = "priority";
	return body;
}

export function supportsFastApi(api: string | undefined): boolean {
	return typeof api === "string" && FAST_APIS.has(api);
}

/** UI / status: only when preference is on and API is known openai-family. */
export function isFastActive(preferred: boolean, api: string | undefined): boolean {
	return preferred && supportsFastApi(api);
}

/**
 * Injection gate:
 * - off preference → never
 * - known non-openai API → never
 * - known openai API → yes
 * - unknown/missing API → yes (avoid silent skip when ctx.model is stale)
 */
export function shouldInjectPriority(preferred: boolean, api: string | undefined): boolean {
	if (!preferred) return false;
	if (api === undefined) return true;
	return supportsFastApi(api);
}

export function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export const TERRIFIC_CONFIG_BASENAME = "terrific.json";

export function resolveConfigPath(agentDir = defaultAgentDir()): string {
	return join(agentDir, TERRIFIC_CONFIG_BASENAME);
}

/** @deprecated use resolveConfigPath */
export function resolveFastConfigPath(agentDir = defaultAgentDir()): string {
	return resolveConfigPath(agentDir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

/** Whether shared config already has a `fast` object (even if enabled:false). */
export function hasFastPreference(agentDir = defaultAgentDir()): boolean {
	const path = resolveConfigPath(agentDir);
	if (!existsSync(path)) return false;
	try {
		const root: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(root) || !Object.hasOwn(root, "fast")) return false;
		return isRecord(root.fast);
	} catch {
		return false;
	}
}

export function loadFastEnabled(agentDir = defaultAgentDir()): boolean {
	const path = resolveConfigPath(agentDir);
	if (!existsSync(path)) return false;
	try {
		const root: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(root) || !isRecord(root.fast)) return false;
		return root.fast.enabled === true;
	} catch {
		// Corrupt config must not block startup; default off.
		return false;
	}
}

type ConfigLockResult =
	| { ok: true; path: string; token: string }
	| { ok: false; error: string };

function acquireConfigLock(path: string): ConfigLockResult {
	const lockPath = `${path}.lock`;
	const token = randomUUID();
	let created = false;
	try {
		const descriptor = openSync(lockPath, "wx", 0o600);
		created = true;
		try {
			writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }), "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		return { ok: true, path: lockPath, token };
	} catch (error) {
		if (created) {
			try {
				unlinkSync(lockPath);
			} catch {
				// ignore
			}
		}
		if (errorCode(error) === "EEXIST") {
			return {
				ok: false,
				error: `another process may be updating the config; remove ${lockPath} only after confirming it is stale`,
			};
		}
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function releaseConfigLock(lock: Extract<ConfigLockResult, { ok: true }>): void {
	try {
		const value: unknown = JSON.parse(readFileSync(lock.path, "utf8"));
		if (isRecord(value) && value.token === lock.token) unlinkSync(lock.path);
	} catch {
		// ignore
	}
}

function syncDirectory(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		fsyncSync(descriptor);
	} catch (error) {
		if (!["EINVAL", "EPERM", "EISDIR"].includes(errorCode(error) ?? "")) throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function writeConfigAtomically(path: string, temporary: string, content: string, mode: number): void {
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(descriptor, content, "utf8");
		chmodSync(temporary, mode);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, path);
	syncDirectory(dirname(path));
}

/** Merge `fast.enabled` into terrific.json under the shared lock protocol. */
export function saveFastEnabled(enabled: boolean, agentDir = defaultAgentDir()): boolean {
	const path = resolveConfigPath(agentDir);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	} catch {
		return false;
	}

	const lock = acquireConfigLock(path);
	if (!lock.ok) return false;

	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		let root: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (!isRecord(parsed)) return false;
				root = parsed;
			} catch {
				return false;
			}
		}

		const prev = isRecord(root.fast) ? root.fast : {};
		root.fast = { ...prev, enabled };

		const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
		writeConfigAtomically(path, temporary, `${JSON.stringify(root, null, 2)}\n`, mode);
		return true;
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(temporary);
		} catch {
			// ignore missing tmp after successful rename
		}
		releaseConfigLock(lock);
	}
}

/** Latest session-local fast-state entry (legacy). */
export function readSessionFastState(ctx: ExtensionContext): boolean | undefined {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type !== "custom" || entry.customType !== FAST_ENTRY_TYPE) continue;
			const data = entry.data as { enabled?: unknown } | undefined;
			if (data && typeof data.enabled === "boolean") return data.enabled;
		}
	} catch {
		// ignore stale sessionManager
	}
	return undefined;
}

function modelApi(ctx: ExtensionContext, model?: { api?: unknown }): string | undefined {
	try {
		const api = model?.api ?? ctx.model?.api;
		return typeof api === "string" ? api : undefined;
	} catch {
		// Stale extension ctx must not block toggle/request paths.
		return undefined;
	}
}

function applyStatus(ctx: ExtensionContext, active: boolean): void {
	ctx.ui.setStatus("fast", active ? FAST_STATUS : undefined);
}

export default function (pi: ExtensionAPI) {
	// User preference (global). Active only when model API is openai-family.
	let preferred = false;

	const refresh = (ctx: ExtensionContext, model?: { api?: unknown }) => {
		applyStatus(ctx, isFastActive(preferred, modelApi(ctx, model)));
	};

	const setPreferred = (ctx: ExtensionContext, next: boolean) => {
		preferred = next;
		if (!saveFastEnabled(preferred)) {
			ctx.ui.notify("Fast preference set in-memory only (failed to write terrific.json)", "warning");
		}

		const api = modelApi(ctx);
		const active = isFastActive(preferred, api);
		applyStatus(ctx, active);

		if (preferred && !active) {
			ctx.ui.notify(
				"Fast preference ON (inactive until openai-family Responses model)",
				"warning",
			);
			return;
		}
		ctx.ui.notify(preferred ? "Fast mode ON (service_tier=priority)" : "Fast mode OFF", "info");
	};

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Priority processing (service_tier=priority)",
		getArgumentCompletions: (prefix) => {
			const opts = ["on", "off", "toggle"];
			const filtered = opts.filter((o) => o.startsWith(prefix.trim()));
			return filtered.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") setPreferred(ctx, true);
			else if (arg === "off") setPreferred(ctx, false);
			else if (arg === "" || arg === "toggle") setPreferred(ctx, !preferred);
			else ctx.ui.notify("Usage: /fast [on|off|toggle]", "error");
		},
	});

	const restore = (ctx: ExtensionContext) => {
		if (hasFastPreference()) {
			preferred = loadFastEnabled();
		} else {
			// One-shot migration from legacy session entries when global key is absent.
			const session = readSessionFastState(ctx);
			if (session !== undefined) {
				preferred = session;
				saveFastEnabled(preferred);
			} else {
				preferred = false;
			}
		}
		refresh(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Preference is global; just re-sync badge after tree navigation.
		refresh(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		// Auto-yield UI when leaving openai-family; restore when returning.
		refresh(ctx, event.model);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!shouldInjectPriority(preferred, modelApi(ctx))) return;
		return injectPriority(event.payload);
	});
}
