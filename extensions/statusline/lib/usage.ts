import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { TokenTotals } from "./types.ts";

export interface SessionUsageTotals {
	tokens: TokenTotals;
	cost: number;
}

type BranchEntry = {
	type: string;
	message?: {
		role?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
	};
};

export function aggregateSessionUsage(entries: readonly BranchEntry[]): SessionUsageTotals {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = (entry.message as AssistantMessage).usage;
		if (!usage) continue;
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		cacheRead += usage.cacheRead ?? 0;
		cacheWrite += usage.cacheWrite ?? 0;
		cost += usage.cost?.total ?? 0;
	}

	return {
		tokens: { input, output, cacheRead, cacheWrite },
		cost,
	};
}
