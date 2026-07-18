import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { truncateToWidth } from "@earendil-works/pi-tui";

import { sanitizeProcessText } from "./state.ts";
import type {
	ActivitySnapshot,
	RecentToolOutcome,
	RuntimeStage,
	ToolActivity,
} from "./types.ts";

export const PROCESS_TOOL_NAME = "process_update";
const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

function truncatePlain(text: string): string {
	return sanitizeProcessText(truncateToWidth(text, 80));
}

function safeToolName(toolName: string): string {
	return truncatePlain(sanitizeProcessText(toolName) || "tool");
}

function safePath(value: string, cwd: string): string {
	const clean = sanitizeProcessText(value);
	if (!clean) return "";
	const root = resolve(cwd);
	const absolute = resolve(root, clean);
	const workspaceRelative = relative(root, absolute);
	const inside = workspaceRelative === ""
		|| (workspaceRelative !== ".." && !workspaceRelative.startsWith(`..${sep}`) && !isAbsolute(workspaceRelative));
	return truncatePlain(inside ? workspaceRelative || basename(absolute) : basename(absolute));
}

export function safeActivityLabel(
	toolName: string,
	args: unknown,
	cwd: string,
): string {
	const name = safeToolName(toolName);
	if (toolName === "bash" || !PATH_TOOLS.has(toolName)) return name;
	if (typeof args !== "object" || args === null || !("path" in args)) return name;
	const path = (args as { path?: unknown }).path;
	return typeof path === "string" ? safePath(path, cwd) || name : name;
}

export class ActivityTracker {
	private stage: RuntimeStage = "settled";
	private readonly activeTools = new Map<string, ToolActivity>();
	private recentOutcome: RecentToolOutcome | undefined;

	beginRequest(): void {
		this.activeTools.clear();
		this.recentOutcome = undefined;
		this.stage = "starting";
	}

	handleAssistantEvent(type: string): void {
		if (this.activeTools.size > 0) return;
		if (type.startsWith("thinking_")) {
			this.stage = this.recentOutcome ? "analyzing_results" : "analyzing";
		} else if (type.startsWith("toolcall_")) {
			this.stage = "preparing_tools";
		} else if (type.startsWith("text_")) {
			this.stage = "drafting";
		}
	}

	startTool(
		callId: string,
		toolName: string,
		args: unknown,
		cwd: string,
		now = Date.now(),
	): void {
		if (toolName === PROCESS_TOOL_NAME) return;
		this.activeTools.set(callId, {
			callId,
			toolName: safeToolName(toolName),
			label: safeActivityLabel(toolName, args, cwd),
			startedAt: now,
		});
		this.stage = "running_tools";
	}

	endTool(
		callId: string,
		toolName: string,
		isError: boolean,
		now = Date.now(),
	): void {
		if (toolName === PROCESS_TOOL_NAME) {
			if (this.activeTools.size === 0) this.stage = "analyzing_results";
			return;
		}
		const activity = this.activeTools.get(callId);
		if (!activity) return;
		this.activeTools.delete(callId);
		this.recentOutcome = {
			toolName: activity.toolName,
			label: activity.label,
			isError,
			finishedAt: now,
		};
		this.stage = this.activeTools.size > 0 ? "running_tools" : "analyzing_results";
	}

	settle(preserveRecent: boolean): void {
		this.activeTools.clear();
		if (!preserveRecent) this.recentOutcome = undefined;
		this.stage = "settled";
	}

	reset(): void {
		this.activeTools.clear();
		this.recentOutcome = undefined;
		this.stage = "settled";
	}

	getSnapshot(): ActivitySnapshot {
		return {
			stage: this.stage,
			activeTools: [...this.activeTools.values()].map((activity) => ({ ...activity })),
			...(this.recentOutcome ? { recentOutcome: { ...this.recentOutcome } } : {}),
		};
	}
}
