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

export function resolveConfigWritePath(agentDir: string): string {
	return resolveConfigPath(agentDir);
}

/**
 * Merge fields into terrific.json → modelProfile.
 * Only patches provided keys; preserves profiles and other root sections.
 */
export function patchModelProfileSection(
	patch: { startup?: boolean; startupScope?: ProfileScope },
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
}
