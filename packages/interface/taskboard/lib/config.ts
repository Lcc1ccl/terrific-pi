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

import type { KeyId } from "@earendil-works/pi-tui";

import type { TaskboardActivityMode, TaskboardViewMode } from "./types.ts";

const MODES = new Set<TaskboardViewMode>(["compact", "full", "off"]);
const ACTIVITY_MODES = new Set<TaskboardActivityMode>(["full", "task", "off"]);
const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const KEY_BASES = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
	"home", "end", "pageUp", "pageDown", "up", "down", "left", "right",
	...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
	..."`-= []\\;',./!@#$%^&*()_+|~{}:<>?".replace(" ", ""),
]);
const DEFAULT_TOGGLE_SHORTCUT: KeyId = "shift+alt+o";
const DEFAULT_MAX_PANEL_LINES = 15;
const BASENAME = "terrific.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configPath(agentDir: string): string {
	return join(agentDir, BASENAME);
}

function taskboardConfig(root: Record<string, unknown>): Record<string, unknown> | undefined {
	if (Object.hasOwn(root, "taskboard")) return isRecord(root.taskboard) ? root.taskboard : undefined;
	// Read-only migration compatibility; the /process command alias was removed in 0.2.0.
	return isRecord(root.processView) ? root.processView : undefined;
}

function loadTaskboardSection(agentDir: string): Record<string, unknown> | undefined {
	const path = configPath(agentDir);
	if (!existsSync(path)) return undefined;
	const root: unknown = JSON.parse(readFileSync(path, "utf8"));
	return isRecord(root) ? taskboardConfig(root) : undefined;
}

export interface TaskboardConfig {
	activityMode: TaskboardActivityMode;
	maxPanelLines: number;
	toggleShortcut: KeyId | undefined;
	invalidToggleShortcut?: string;
}

function isKeyId(value: string): value is KeyId {
	if (!value || value.trim() !== value) return false;
	let base = value;
	let modifierText = "";
	if (value !== "+") {
		if (value.endsWith("++")) {
			base = "+";
			modifierText = value.slice(0, -2);
		} else {
			const separator = value.lastIndexOf("+");
			if (separator >= 0) {
				base = value.slice(separator + 1);
				modifierText = value.slice(0, separator);
			}
		}
	}
	if (!KEY_BASES.has(base)) return false;
	if (!modifierText) return true;
	const modifiers = modifierText.split("+");
	return modifiers.every((modifier) => KEY_MODIFIERS.has(modifier))
		&& new Set(modifiers).size === modifiers.length;
}

export function loadTaskboardConfig(
	agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): TaskboardConfig {
	const defaults: TaskboardConfig = {
		activityMode: "full",
		maxPanelLines: DEFAULT_MAX_PANEL_LINES,
		toggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
	};
	try {
		const section = loadTaskboardSection(agentDir);
		const activityMode = typeof section?.activityMode === "string"
			&& ACTIVITY_MODES.has(section.activityMode as TaskboardActivityMode)
			? section.activityMode as TaskboardActivityMode
			: defaults.activityMode;
		const maxPanelLines = Number.isInteger(section?.maxPanelLines)
			&& Number(section?.maxPanelLines) >= 8
			&& Number(section?.maxPanelLines) <= 20
			? Number(section?.maxPanelLines)
			: defaults.maxPanelLines;
		const shortcut = section?.toggleShortcut;
		if (shortcut === undefined) return { activityMode, maxPanelLines, toggleShortcut: DEFAULT_TOGGLE_SHORTCUT };
		if (shortcut === "off") return { activityMode, maxPanelLines, toggleShortcut: undefined };
		if (typeof shortcut === "string" && isKeyId(shortcut)) {
			return { activityMode, maxPanelLines, toggleShortcut: shortcut };
		}
		return {
			activityMode,
			maxPanelLines,
			toggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
			invalidToggleShortcut: String(shortcut).slice(0, 120),
		};
	} catch {
		return defaults;
	}
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
	return loadTaskboardConfig(agentDir).activityMode;
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
