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

/** Exact on-disk state captured before Pi persists a model switch. */
export type SettingsFileSnapshot =
	| { ok: true; path: string; exists: false }
	| { ok: true; path: string; exists: true; content: string; mode: number }
	| { ok: false; path: string; error: string };

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

function writeFileAtomically(path: string, content: string, mode: number, prefix: string): void {
	const temporary = join(dirname(path), `.${prefix}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, content, "utf8");
			chmodSync(temporary, mode);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// ignore
		}
		throw error;
	}
}

/** Capture settings.json byte-for-byte, including its absence or malformed JSON. */
export function snapshotSettingsFile(agentDir: string): SettingsFileSnapshot {
	const path = resolveSettingsPath(agentDir);
	try {
		const stats = statSync(path);
		return {
			ok: true,
			path,
			exists: true,
			content: readFileSync(path, "utf8"),
			mode: stats.mode & 0o777,
		};
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { ok: true, path, exists: false };
		return {
			ok: false,
			path,
			error: `Cannot snapshot settings.json: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Compare-and-restore prior model defaults after Pi persists a session switch. */
export function restoreSettingsFile(
	snapshot: Extract<SettingsFileSnapshot, { ok: true }>,
	expected: SettingsDefaults,
): WriteSettingsResult {
	const path = snapshot.path;
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
	if (!lock.ok) return { ok: false, path, error: lock.error };
	try {
		let current: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!isRecord(parsed)) throw new Error("settings.json root is not an object");
			current = parsed;
		} catch (error) {
			return { ok: false, path, error: `Cannot safely restore settings defaults: ${error instanceof Error ? error.message : String(error)}` };
		}
		let original: Record<string, unknown> = {};
		if (snapshot.exists) {
			try {
				const parsed: unknown = JSON.parse(snapshot.content);
				if (!isRecord(parsed)) throw new Error("snapshot root is not an object");
				original = parsed;
			} catch {
				return { ok: false, path, error: "Cannot safely restore defaults from a malformed settings.json snapshot" };
			}
		}
		const originalPair = [original.defaultProvider, original.defaultModel];
		const currentPair = [current.defaultProvider, current.defaultModel];
		const expectedPair = [expected.defaultProvider, expected.defaultModel];
		const pairMatches = (left: unknown[], right: unknown[]) => left[0] === right[0] && left[1] === right[1];
		const thinkingMatches = current.defaultThinkingLevel === expected.defaultThinkingLevel
			|| current.defaultThinkingLevel === original.defaultThinkingLevel;
		if ((!pairMatches(currentPair, expectedPair) && !pairMatches(currentPair, originalPair)) || !thinkingMatches) {
			return { ok: false, path, error: "settings.json model defaults changed concurrently; current values were preserved" };
		}
		for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const) {
			if (Object.hasOwn(original, key)) current[key] = original[key];
			else delete current[key];
		}
		const mode = existsSync(path) ? statSync(path).mode & 0o777 : snapshot.exists ? snapshot.mode : 0o600;
		writeFileAtomically(path, `${JSON.stringify(current, null, 2)}\n`, mode, "settings");
		return { ok: true, path };
	} catch (error) {
		return {
			ok: false,
			path,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		releaseLock(lock);
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
		writeFileAtomically(path, `${JSON.stringify(root, null, 2)}\n`, mode, "settings");
		return { ok: true, path };
	} catch (error) {
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
