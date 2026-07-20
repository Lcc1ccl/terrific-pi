import type { ModeName } from "./config.ts";

export const ASK_TOOLS = ["read", "grep", "find", "ls"] as const;
export const PLAN_TOOLS = ["read", "grep", "find", "ls"] as const;
const READ_ONLY_AUXILIARY_TOOLS = new Set(["aux_summarize", "web_research"]);

export const MODE_STATUS_KEY = "mode";
export const MODE_ENTRY_TYPE = "mode";

export function uniqueTools(tools: readonly string[]): string[] {
	return [...new Set(tools)];
}

/** Resolve tool list for a mode. edit/auto restore baseline. */
export function toolsForMode(mode: ModeName, baselineTools: readonly string[]): string[] {
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

export function parseModeArg(arg: string): ModeName | undefined {
	const value = arg.trim().toLowerCase();
	if (value === "ask" || value === "plan" || value === "edit" || value === "auto") return value;
	return undefined;
}

export function modeLabel(mode: ModeName): string {
	return mode.toUpperCase();
}

export function isModeName(value: unknown): value is ModeName {
	return value === "ask" || value === "plan" || value === "edit" || value === "auto";
}
