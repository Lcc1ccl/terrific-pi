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
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { isThinkingLevel } from "./config.ts";
import type { ThinkingLevel } from "./types.ts";

export interface SettingsDefaults {
	defaultProvider: string;
	defaultModel: string;
	defaultThinkingLevel: ThinkingLevel;
}

/** Snapshot that may lack thinking when settings.json is incomplete. */
export interface SettingsDefaultsSnapshot {
	defaultProvider: string;
	defaultModel: string;
	defaultThinkingLevel?: ThinkingLevel;
	/** True when defaultThinkingLevel was missing/invalid in file. */
	incomplete: boolean;
}

export type WriteSettingsResult =
	| { ok: true; path: string }
	| { ok: false; error: string; path: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

export function resolveSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

type Lock =
	| { ok: true; path: string; token: string }
	| { ok: false; error: string };

function acquireLock(targetPath: string): Lock {
	const lockPath = `${targetPath}.lock`;
	const token = randomUUID();
	let created = false;
	try {
		const descriptor = openSync(lockPath, "wx", 0o600);
		created = true;
		try {
			writeFileSync(
				descriptor,
				JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }),
				"utf8",
			);
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
				error: `settings.json is locked (${lockPath}); retry after other writers finish`,
			};
		}
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function releaseLock(lock: Extract<Lock, { ok: true }>): void {
	try {
		const value: unknown = JSON.parse(readFileSync(lock.path, "utf8"));
		if (isRecord(value) && value.token === lock.token) unlinkSync(lock.path);
	} catch {
		// ignore
	}
}

/**
 * Read global default model fields from settings.json.
 * Returns undefined if file missing, corrupt, or provider/model incomplete.
 */
export function readSettingsDefaults(agentDir: string): SettingsDefaultsSnapshot | undefined {
	const path = resolveSettingsPath(agentDir);
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return undefined;
		const provider = parsed.defaultProvider;
		const model = parsed.defaultModel;
		if (typeof provider !== "string" || provider.trim() === "") return undefined;
		if (typeof model !== "string" || model.trim() === "") return undefined;
		const thinking = parsed.defaultThinkingLevel;
		if (isThinkingLevel(thinking)) {
			return {
				defaultProvider: provider,
				defaultModel: model,
				defaultThinkingLevel: thinking,
				incomplete: false,
			};
		}
		return {
			defaultProvider: provider,
			defaultModel: model,
			incomplete: true,
		};
	} catch {
		return undefined;
	}
}

/**
 * Patch defaultProvider / defaultModel / defaultThinkingLevel in settings.json.
 * Uses a simple lock file to reduce concurrent clobbering.
 */
export function writeSettingsDefaults(
	defaults: SettingsDefaults,
	agentDir: string,
): WriteSettingsResult {
	const path = resolveSettingsPath(agentDir);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	} catch (error) {
		return {
			ok: false,
			path,
			error: `Cannot create agent dir: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const lock = acquireLock(path);
	if (!lock.ok) {
		return { ok: false, path, error: lock.error };
	}

	const temporary = join(dirname(path), `.settings.${process.pid}.${randomUUID()}.tmp`);
	try {
		let root: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (!isRecord(parsed)) {
					return { ok: false, path, error: "settings.json root is not an object" };
				}
				root = parsed;
			} catch (error) {
				return {
					ok: false,
					path,
					error: `Failed to parse settings.json: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		root.defaultProvider = defaults.defaultProvider;
		root.defaultModel = defaults.defaultModel;
		root.defaultThinkingLevel = defaults.defaultThinkingLevel;

		const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(root, null, 2)}\n`, "utf8");
			chmodSync(temporary, mode);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
		return { ok: true, path };
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// ignore
		}
		return {
			ok: false,
			path,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		releaseLock(lock);
	}
}

/** Build a full SettingsDefaults for restore, filling missing thinking from fallback. */
export function snapshotToRestoreDefaults(
	snapshot: SettingsDefaultsSnapshot,
	thinkingFallback: ThinkingLevel,
): { defaults: SettingsDefaults; usedThinkingFallback: boolean } {
	if (snapshot.defaultThinkingLevel) {
		return {
			defaults: {
				defaultProvider: snapshot.defaultProvider,
				defaultModel: snapshot.defaultModel,
				defaultThinkingLevel: snapshot.defaultThinkingLevel,
			},
			usedThinkingFallback: false,
		};
	}
	return {
		defaults: {
			defaultProvider: snapshot.defaultProvider,
			defaultModel: snapshot.defaultModel,
			defaultThinkingLevel: thinkingFallback,
		},
		usedThinkingFallback: true,
	};
}
