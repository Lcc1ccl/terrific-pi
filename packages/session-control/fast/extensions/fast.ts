/**
 * /fast — toggle OpenAI Priority processing (service_tier: priority).
 *
 * Preference is global (terrific.json) and persists across sessions.
 * Effective only for GPT models on openai-family Responses APIs; others auto-yield.
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

import { formatFastStatus } from "../lib/status.ts";

const FAST_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);
const FAST_STATUS = "";
const FAST_ENTRY_TYPE = "fast-state";
const PRESENTATION_EVENT_NAME = "terrific-pi:presentation:event-v1";

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

/** Strict GPT model ids only: `gpt`, `gpt-*`, `gpt.*` (case-insensitive). */
export function isGptModelId(modelId: string | undefined): boolean {
	if (typeof modelId !== "string") return false;
	const id = modelId.trim().toLowerCase();
	if (!id) return false;
	return id === "gpt" || id.startsWith("gpt-") || id.startsWith("gpt.");
}

/** API family + GPT model id both required. */
export function supportsFastModel(api: string | undefined, modelId: string | undefined): boolean {
	return supportsFastApi(api) && isGptModelId(modelId);
}

/** UI / status: preference on and current model is a GPT Responses model. */
export function isFastActive(
	preferred: boolean,
	api: string | undefined,
	modelId?: string,
): boolean {
	return preferred && supportsFastModel(api, modelId);
}

/** Keep billing behavior aligned with the visible active-state badge. */
export function shouldInjectPriority(
	preferred: boolean,
	api: string | undefined,
	modelId?: string,
): boolean {
	return isFastActive(preferred, api, modelId);
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

type ModelLike = { api?: unknown; id?: unknown };

function readModelApi(model?: ModelLike): string | undefined {
	return typeof model?.api === "string" ? model.api : undefined;
}

function readModelId(model?: ModelLike): string | undefined {
	return typeof model?.id === "string" ? model.id : undefined;
}

function modelApi(ctx: ExtensionContext, model?: ModelLike): string | undefined {
	const fromModel = readModelApi(model);
	if (fromModel !== undefined) return fromModel;
	try {
		return readModelApi(ctx.model);
	} catch {
		// Stale extension ctx must not block toggle/request paths.
		return undefined;
	}
}

function modelIdOf(ctx: ExtensionContext, model?: ModelLike): string | undefined {
	const fromModel = readModelId(model);
	if (fromModel !== undefined) return fromModel;
	try {
		return readModelId(ctx.model);
	} catch {
		return undefined;
	}
}

function applyStatus(ctx: ExtensionContext, active: boolean): void {
	ctx.ui.setStatus("fast", active ? FAST_STATUS : undefined);
}

function reportFastStatus(
	ctx: ExtensionContext,
	preferred: boolean,
	api: string | undefined,
	modelId: string | undefined,
): void {
	const text = formatFastStatus(preferred, api, resolveConfigPath(), modelId);
	if (ctx.mode === "print") process.stdout.write(`${text}\n`);
	else ctx.ui.notify(text, "info");
}

export default function (pi: ExtensionAPI) {
	// User preference (global). Active only for GPT + openai-family Responses.
	let preferred = false;
	/** Last model snapshot from model_select. Authoritative once observed. */
	let lastApi: string | undefined;
	let lastModelId: string | undefined;
	let hasObservedModel = false;

	const rememberModel = (api: string | undefined, modelId: string | undefined) => {
		lastApi = api;
		lastModelId = modelId;
		hasObservedModel = true;
	};

	/**
	 * Resolve effective model for badge/injection.
	 * Order: explicit model arg → live ctx.model (even if fields missing) → last model_select.
	 * A present model with no api/id is treated as unknown (no inject), not as last snapshot.
	 */
	const currentModel = (
		ctx: ExtensionContext,
		model?: ModelLike,
	): { api: string | undefined; modelId: string | undefined } => {
		if (model !== undefined) {
			return { api: readModelApi(model), modelId: readModelId(model) };
		}
		try {
			if (ctx.model) {
				return { api: readModelApi(ctx.model), modelId: readModelId(ctx.model) };
			}
		} catch {
			// fall through to last snapshot
		}
		if (hasObservedModel) return { api: lastApi, modelId: lastModelId };
		return { api: undefined, modelId: undefined };
	};

	const refresh = (ctx: ExtensionContext, model?: ModelLike) => {
		if (model !== undefined) {
			// model_select: record event model (incl. missing fields → yield).
			rememberModel(readModelApi(model), readModelId(model));
			applyStatus(ctx, isFastActive(preferred, lastApi, lastModelId));
			return;
		}
		const liveApi = modelApi(ctx);
		const liveId = modelIdOf(ctx);
		if (liveApi !== undefined || liveId !== undefined || !hasObservedModel) {
			rememberModel(liveApi, liveId);
		}
		const current = currentModel(ctx);
		applyStatus(ctx, isFastActive(preferred, current.api, current.modelId));
	};

	const setPreferred = (ctx: ExtensionContext, next: boolean) => {
		if (!saveFastEnabled(next)) {
			ctx.ui.notify("Fast preference unchanged (failed to write terrific.json)", "warning");
			return;
		}
		preferred = next;

		const current = currentModel(ctx);
		const active = isFastActive(preferred, current.api, current.modelId);
		applyStatus(ctx, active);
		const presentationEvent: {
			version: 1;
			kind: "fast";
			source: "user";
			tone: "success" | "warning" | "muted";
			label: "Fast";
			message: string;
			dedupeKey: string;
			presentationHandled?: boolean;
		} = {
			version: 1,
			kind: "fast",
			source: "user",
			tone: preferred && active ? "success" : preferred ? "warning" : "muted",
			label: "Fast",
			message: preferred ? `ON · ${active ? "active" : "waiting for compatible GPT model"}` : "OFF",
			dedupeKey: `fast:${preferred ? "on" : "off"}:${active ? "active" : "inactive"}`,
		};
		const events = (pi as ExtensionAPI & { events?: { emit(name: string, value: unknown): void } }).events;
		events?.emit(PRESENTATION_EVENT_NAME, presentationEvent);
		if (presentationEvent.presentationHandled) return;

		if (preferred && !active) {
			ctx.ui.notify(
				"Fast preference ON (inactive until a GPT model on openai-family Responses)",
				"warning",
			);
			return;
		}
		ctx.ui.notify(preferred ? "Fast mode ON (service_tier=priority)" : "Fast mode OFF", "info");
	};

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Priority processing or show status (on|off|toggle|status)",
		getArgumentCompletions: (prefix) => {
			const opts = ["on", "off", "toggle", "status"];
			const filtered = opts.filter((option) => option.startsWith(prefix.trim().toLowerCase()));
			return filtered.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			preferred = loadFastEnabled();
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				const current = currentModel(ctx);
				reportFastStatus(ctx, preferred, current.api, current.modelId);
			} else if (arg === "on") setPreferred(ctx, true);
			else if (arg === "off") setPreferred(ctx, false);
			else if (arg === "" || arg === "toggle") setPreferred(ctx, !preferred);
			else ctx.ui.notify("Usage: /fast [on|off|toggle|status]", "error");
		},
	});

	const restore = (ctx: ExtensionContext) => {
		if (hasFastPreference()) {
			preferred = loadFastEnabled();
		} else {
			// One-shot migration from legacy session entries when global key is absent.
			const session = readSessionFastState(ctx);
			preferred = session !== undefined && saveFastEnabled(session) ? session : false;
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
		// model-profile / /model / cycle all emit this after setModel.
		// Non-GPT or non-openai-family → yield immediately.
		refresh(ctx, event.model);
	});

	// Re-read the file at request boundaries so external edits are authoritative.
	pi.on("before_agent_start", async (_event, ctx) => {
		preferred = loadFastEnabled();
		refresh(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		preferred = loadFastEnabled();
		const current = currentModel(ctx);
		// Payload model id is a secondary check when session model id is missing.
		const payloadModel =
			event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
				? (event.payload as { model?: unknown }).model
				: undefined;
		const modelId =
			current.modelId ?? (typeof payloadModel === "string" ? payloadModel : undefined);
		if (!shouldInjectPriority(preferred, current.api, modelId)) return;
		return injectPriority(event.payload);
	});
}
