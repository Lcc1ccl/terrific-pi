import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppearanceProfileResult {
	active: boolean;
	error?: string;
}

export function resolveAppearanceAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function readAppearanceProfile(agentDir = resolveAppearanceAgentDir()): AppearanceProfileResult {
	let source: string;
	try {
		source = readFileSync(join(agentDir, "terrific.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: false };
		return { active: false, error: `Unable to read global appearance config: ${String(error)}` };
	}

	let config: unknown;
	try {
		config = JSON.parse(source);
	} catch (error) {
		return { active: false, error: `Unable to parse global appearance JSON: ${String(error)}` };
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) return { active: false };
	const appearance = (config as Record<string, unknown>).appearance;
	if (appearance === undefined) return { active: false };
	if (!appearance || typeof appearance !== "object" || Array.isArray(appearance)) {
		return { active: false, error: "Global appearance config must be an object" };
	}
	return { active: (appearance as Record<string, unknown>).profile === "terrific-native-v1" };
}

export function createAppearanceProfileReader(
	agentDir = resolveAppearanceAgentDir(),
): () => AppearanceProfileResult {
	let cached: AppearanceProfileResult | undefined;
	return () => cached ??= readAppearanceProfile(agentDir);
}
