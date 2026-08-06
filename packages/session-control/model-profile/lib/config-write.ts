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

import type { ProfileScope } from "./types.ts";
import { TERRIFIC_CONFIG_BASENAME, resolveConfigPath } from "./config.ts";

export type WriteConfigResult =
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

const STALE_LOCK_MS = 60_000;

type ConfigLock =
	| { ok: true; path: string; token: string }
	| { ok: false; error: string };

function lockOwnerIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function isRecoverableLock(lockPath: string): boolean {
	try {
		const value: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
		if (
			isRecord(value)
			&& typeof value.pid === "number"
			&& Number.isInteger(value.pid)
			&& value.pid > 0
		) {
			return !lockOwnerIsAlive(value.pid);
		}
	} catch {
		// Legacy empty locks are recoverable after their modification time ages out.
	}

	try {
		return Date.now() - statSync(lockPath).mtimeMs >= STALE_LOCK_MS;
	} catch {
		return false;
	}
}

function acquireConfigLock(path: string): ConfigLock {
	const lockPath = `${path}.lock`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
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
			if (errorCode(error) === "EEXIST" && attempt === 0 && isRecoverableLock(lockPath)) {
				try {
					unlinkSync(lockPath);
					continue;
				} catch {
					// Report the lock below if it could not be reclaimed.
				}
			}
			if (errorCode(error) === "EEXIST") {
				return {
					ok: false,
					error: `${TERRIFIC_CONFIG_BASENAME} is locked (${lockPath}); retry after other writers finish`,
				};
			}
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
	return { ok: false, error: `${TERRIFIC_CONFIG_BASENAME} is locked (${lockPath})` };
}

function releaseConfigLock(lock: Extract<ConfigLock, { ok: true }>): void {
	try {
		const value: unknown = JSON.parse(readFileSync(lock.path, "utf8"));
		if (isRecord(value) && value.token === lock.token) unlinkSync(lock.path);
	} catch {
		// Leave the write result intact if lock cleanup fails.
	}
}

export function resolveConfigWritePath(agentDir: string): string {
	return resolveConfigPath(agentDir);
}

/**
 * Merge fields into terrific.json → modelProfile.
 * Only patches provided keys; preserves profiles and other root sections.
 */
export function patchModelProfileSection(
	patch: { startup?: boolean; startupScope?: ProfileScope; openHotkey?: string; profiles?: unknown[] },
	agentDir: string,
): WriteConfigResult {
	const path = resolveConfigPath(agentDir);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	} catch (error) {
		return {
			ok: false,
			path,
			error: `Cannot create agent dir: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const lock = acquireConfigLock(path);
	if (!lock.ok) return { ok: false, path, error: lock.error };

	try {
		let root: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (!isRecord(parsed)) {
					return { ok: false, path, error: `${TERRIFIC_CONFIG_BASENAME} root is not an object` };
				}
				root = parsed;
			} catch (error) {
				return {
					ok: false,
					path,
					error: `Failed to parse ${TERRIFIC_CONFIG_BASENAME}: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		const prev = isRecord(root.modelProfile) ? root.modelProfile : {};
		root.modelProfile = {
			...prev,
			...(patch.startup !== undefined ? { startup: patch.startup } : {}),
			...(patch.startupScope !== undefined ? { startupScope: patch.startupScope } : {}),
			...(patch.openHotkey !== undefined ? { openHotkey: patch.openHotkey } : {}),
			...(patch.profiles !== undefined ? { profiles: patch.profiles } : {}),
		};

		const temporary = join(dirname(path), `.terrific.${process.pid}.${randomUUID()}.tmp`);
		const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;

		try {
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
		}
	} finally {
		releaseConfigLock(lock);
	}
}
