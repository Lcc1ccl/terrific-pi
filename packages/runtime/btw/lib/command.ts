import type { TerrificConfig } from "./config.ts";

export type BtwContextMode = "current" | "none";

export function parseBtwCommandArgs(raw: string): { contextMode: BtwContextMode; question: string } {
	const trimmed = raw.trim();
	const match = trimmed.match(/^context=(current|none)(?:\s+|$)/i);
	if (!match) return { contextMode: "current", question: trimmed };
	return {
		contextMode: match[1]!.toLowerCase() as BtwContextMode,
		question: trimmed.slice(match[0].length).trim(),
	};
}

export function formatBtwStatus(
	config: TerrificConfig,
	currentModel: string | undefined,
	configPaths: readonly string[],
): string {
	const route = config.auxiliaryBtw;
	return [
		`Route: ${route ? `auxiliary · ${route.model}` : `current · ${currentModel ?? "none"}`}`,
		`Fallbacks: ${route?.fallbackModels.join(", ") || "none"}`,
		`Thinking: ${route?.thinking ?? config.btw.thinking}`,
		`Timeout: ${route ? `${route.timeoutMs}ms` : "none"}`,
		`Output cap: ${route?.maxOutputTokens ?? config.btw.maxOutputTokens}`,
		`Context budget: ${config.btw.maxContextTokens}`,
		`Config: ${configPaths.join(" -> ")}`,
	].join("\n");
}
