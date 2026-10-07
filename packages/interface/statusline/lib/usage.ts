import { calculateCost, type Api, type Model } from "@earendil-works/pi-ai";

import type { TokenTotals } from "./types.ts";

export interface SessionUsageTotals {
	tokens: TokenTotals;
	cost: number;
}

type BranchEntry = {
	type: string;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
	};
};

export function aggregateSessionUsage(
	entries: readonly BranchEntry[],
	findModel?: (provider: string, modelId: string) => Model<Api> | undefined,
): SessionUsageTotals {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const message = entry.message;
		const usage = message.usage;
		if (!usage) continue;
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		cacheRead += usage.cacheRead ?? 0;
		cacheWrite += usage.cacheWrite ?? 0;
		const model = message.provider && message.model ? findModel?.(message.provider, message.model) : undefined;
		cost += model ? calculateCost(model, {
			...usage,
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		}).total : usage.cost?.total ?? 0;
	}

	return {
		tokens: { input, output, cacheRead, cacheWrite },
		cost,
	};
}
