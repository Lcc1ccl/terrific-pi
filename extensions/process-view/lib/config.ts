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
import { dirname, join } from "node:path";

import type { ProcessViewMode } from "./types.ts";

const MODES = new Set<ProcessViewMode>(["compact", "full", "off"]);
const BASENAME = "terrific.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configPath(agentDir: string): string {
	return join(agentDir, BASENAME);
}

export function loadProcessViewDefault(
	agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): ProcessViewMode {
	try {
		const path = configPath(agentDir);
		if (!existsSync(path)) return "compact";
		const root: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(root) || !isRecord(root.processView)) return "compact";
		const value = root.processView.defaultViewMode;
		return typeof value === "string" && MODES.has(value as ProcessViewMode) ? value as ProcessViewMode : "compact";
	} catch {
		return "compact";
	}
}

export type ProcessViewConfigWriteResult = { ok: true; path: string } | { ok: false; path: string; error: string };

export function updateProcessViewConfig(agentDir: string, defaultViewMode: ProcessViewMode): ProcessViewConfigWriteResult {
	const path = configPath(agentDir);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	} catch (error) {
		return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
	}
	const lockPath = `${path}.lock`;
	try {
		const descriptor = openSync(lockPath, "wx", 0o600);
		closeSync(descriptor);
	} catch (error) {
		return { ok: false, path, error: `Failed to lock ${BASENAME}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const temporary = join(dirname(path), `.${BASENAME}.${process.pid}.${randomUUID()}.tmp`);
	try {
		let root: Record<string, unknown> = {};
		if (existsSync(path)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(path, "utf8"));
			} catch (error) {
				return { ok: false, path, error: `Failed to parse ${BASENAME}: ${error instanceof Error ? error.message : String(error)}` };
			}
			if (!isRecord(parsed)) return { ok: false, path, error: `${BASENAME} root must be an object` };
			root = parsed;
		}
		if (Object.hasOwn(root, "processView") && !isRecord(root.processView)) {
			return { ok: false, path, error: "processView must be a JSON object" };
		}
		root.processView = { ...(isRecord(root.processView) ? root.processView : {}), defaultViewMode };
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(root, null, 2)}\n`, "utf8");
			chmodSync(temporary, existsSync(path) ? statSync(path).mode & 0o777 : 0o600);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
		return { ok: true, path };
	} catch (error) {
		return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
	} finally {
		try {
			unlinkSync(temporary);
		} catch {}
		try {
			unlinkSync(lockPath);
		} catch {}
	}
}
