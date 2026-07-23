import type { PilotMode } from "./activation.ts";

export const MODE_STATUS_KEY = "mode";
export const ASK_TOOLS = ["read", "grep", "find", "ls"] as const;
export const PLAN_TOOLS = ["read", "grep", "find", "ls"] as const;

const READ_ONLY_AUXILIARY_TOOLS = new Set(["aux_summarize", "web_research"]);

export function uniqueTools(tools: readonly string[]): string[] {
	return [...new Set(tools)];
}

export function toolsForMode(mode: PilotMode, baselineTools: readonly string[]): string[] {
	switch (mode) {
		case "ask":
			return uniqueTools([...ASK_TOOLS, ...baselineTools.filter((tool) => READ_ONLY_AUXILIARY_TOOLS.has(tool))]);
		case "plan":
			return uniqueTools([...PLAN_TOOLS, ...baselineTools.filter((tool) => READ_ONLY_AUXILIARY_TOOLS.has(tool))]);
		case "edit":
		case "auto":
			return uniqueTools(baselineTools.length > 0 ? baselineTools : ["read", "bash", "edit", "write"]);
	}
}

export function parseModeArg(arg: string): PilotMode | undefined {
	const value = arg.trim().toLowerCase();
	return value === "ask" || value === "plan" || value === "edit" || value === "auto" ? value : undefined;
}

export function modeLabel(mode: PilotMode): string {
	return mode.toUpperCase();
}

export function roleContract(mode: Exclude<PilotMode, "auto">): string {
	switch (mode) {
		case "ask":
			return "You are in ASK mode. Answer or analyze using read-only tools. Do not modify files, run mutating commands, or claim changes were made.";
		case "plan":
			return "You are in PLAN mode. Inspect facts and produce an implementation plan only. Do not modify files, run mutating commands, or start implementation.";
		case "edit":
			return "You are in EDIT mode. Follow the user's requested change and the applicable project instructions.";
	}
}
