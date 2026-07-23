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

import type { TaskboardActivityMode, TaskboardViewMode } from "./types.ts";

const MODES = new Set<TaskboardViewMode>(["compact", "full", "off"]);
const ACTIVITY_MODES = new Set<TaskboardActivityMode>(["full", "task", "off"]);
const BASENAME = "terrific.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configPath(agentDir: string): string {
	return join(agentDir, BASENAME);
}

function taskboardConfig(root: Record<string, unknown>): Record<string, unknown> | undefined {
	if (Object.hasOwn(root, "taskboard")) return isRecord(root.taskboard) ? root.taskboard : undefined;
	// Compatibility through 0.1.x; remove the processView fallback in 0.2.0.
	return isRecord(root.processView) ? root.processView : undefined;
}

function loadTaskboardSection(agentDir: string): Record<string, unknown> | undefined {
	const path = configPath(agentDir);
	if (!existsSync(path)) return undefined;
	const root: unknown = JSON.parse(readFileSync(path, "utf8"));
	return isRecord(root) ? taskboardConfig(root) : undefined;
}

export function loadTaskboardDefault(
	agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): TaskboardViewMode {
	try {
		const value = loadTaskboardSection(agentDir)?.defaultViewMode;
		return typeof value === "string" && MODES.has(value as TaskboardViewMode) ? value as TaskboardViewMode : "compact";
	} catch {
		return "compact";
	}
}

export function loadTaskboardActivityMode(
	agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): TaskboardActivityMode {
	try {
		const value = loadTaskboardSection(agentDir)?.activityMode;
		return typeof value === "string" && ACTIVITY_MODES.has(value as TaskboardActivityMode)
			? value as TaskboardActivityMode
			: "full";
	} catch {
		return "full";
	}
}

export type TaskboardConfigWriteResult = { ok: true; path: string } | { ok: false; path: string; error: string };

export function updateTaskboardConfig(agentDir: string, defaultViewMode: TaskboardViewMode): TaskboardConfigWriteResult {
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
		if (Object.hasOwn(root, "taskboard") && !isRecord(root.taskboard)) {
			return { ok: false, path, error: "taskboard must be a JSON object" };
		}
		if (!Object.hasOwn(root, "taskboard") && Object.hasOwn(root, "processView") && !isRecord(root.processView)) {
			return { ok: false, path, error: "processView must be a JSON object" };
		}
		const legacy = isRecord(root.processView) ? root.processView : {};
		const canonical = isRecord(root.taskboard) ? root.taskboard : {};
		root.taskboard = { ...legacy, ...canonical, defaultViewMode };
		delete root.processView;
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
