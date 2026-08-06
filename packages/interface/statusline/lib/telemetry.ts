// Derived from OldSuns/pi-open-tui telemetry.ts at commit c280fcd.
// Modified for settled-run aggregation, nullable malformed usage, and statusline-only rendering.

const STALL_THRESHOLD_MS = 1_000;

export interface TurnPerformanceView {
	tps: number | null;
	ttftMs: number;
	totalMs: number;
	inputTokens: number | null;
	outputTokens: number | null;
	stallMs: number;
	stallCount: number;
	rateUsdPerMTokens: number | null;
	generationMs: number;
	totalTokens: number | null;
	costUsd: number | null;
	measurementMs: number | null;
	usageAvailable: boolean;
}

type UsageMessage = {
	role: string;
	usage?: {
		input?: number;
		output?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
};

type TelemetryEvent = {
	type: string;
	message?: UsageMessage;
	assistantMessageEvent?: { type: string; delta?: string };
};

type MessageTiming = {
	lastUpdateMs: number;
	firstOutputMs: number | null;
	inStall: boolean;
};

type TurnTiming = {
	startMs: number;
	firstTokenMs: number | null;
	currentMessage: MessageTiming | null;
	messages: UsageMessage[];
	generationMs: number;
	stallMs: number;
	stallCount: number;
};

function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

export class TurnTelemetryTracker {
	private turn: TurnTiming | undefined;
	private agentStartMs: number | null = null;
	private agentTurns: TurnPerformanceView[] = [];
	private lastSettled: TurnPerformanceView | undefined;

	private readonly now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	handle(event: TelemetryEvent): TurnPerformanceView | undefined {
		switch (event.type) {
			case "agent_start":
				this.agentStartMs = this.now();
				this.agentTurns = [];
				this.turn = undefined;
				this.lastSettled = undefined;
				return;
			case "turn_start":
				this.turn = {
					startMs: this.now(),
					firstTokenMs: null,
					currentMessage: null,
					messages: [],
					generationMs: 0,
					stallMs: 0,
					stallCount: 0,
				};
				return;
			case "message_start":
				this.startMessage(event.message);
				return;
			case "message_update":
				this.updateMessage(event);
				return;
			case "message_end":
				this.endMessage(event.message);
				return;
			case "turn_end": {
				const turn = this.endTurn();
				if (turn && this.agentStartMs !== null) this.agentTurns.push(turn);
				return;
			}
			case "agent_settled":
				return this.endAgent();
			default:
				return;
		}
	}

	reset(_reason?: "abort" | "tree" | "compact" | "reload" | "shutdown" | "session"): void {
		this.turn = undefined;
		this.agentStartMs = null;
		this.agentTurns = [];
		this.lastSettled = undefined;
	}

	getLastSettled(): TurnPerformanceView | undefined {
		return this.lastSettled;
	}

	private startMessage(message: UsageMessage | undefined): void {
		if (!this.turn || message?.role !== "assistant") return;
		const now = this.now();
		this.turn.currentMessage = { lastUpdateMs: now, firstOutputMs: null, inStall: false };
	}

	private updateMessage(event: TelemetryEvent): void {
		const stream = event.assistantMessageEvent;
		if (!stream || !["text_delta", "thinking_delta", "toolcall_delta"].includes(stream.type) || !stream.delta) return;
		const turn = this.turn;
		const current = turn?.currentMessage;
		if (!turn || !current || event.message?.role !== "assistant") return;
		const now = this.now();
		if (current.firstOutputMs === null) {
			current.firstOutputMs = now;
			turn.firstTokenMs ??= now;
			current.lastUpdateMs = now;
			return;
		}
		const gap = now - current.lastUpdateMs;
		if (gap >= STALL_THRESHOLD_MS) {
			if (!current.inStall) turn.stallCount += 1;
			current.inStall = true;
			turn.stallMs += gap;
		} else {
			current.inStall = false;
		}
		current.lastUpdateMs = now;
	}

	private endMessage(message: UsageMessage | undefined): void {
		const turn = this.turn;
		if (!turn || message?.role !== "assistant") return;
		if (turn.currentMessage) {
			const end = this.now();
			turn.generationMs = end - turn.startMs;
			if (turn.currentMessage.firstOutputMs === null && (message.usage?.output ?? 0) > 0) {
				turn.firstTokenMs ??= end;
			}
			turn.currentMessage = null;
		}
		turn.messages.push(message);
	}

	private endTurn(): TurnPerformanceView | undefined {
		const turn = this.turn;
		this.turn = undefined;
		if (!turn || turn.firstTokenMs === null || turn.messages.length === 0) return;
		const values = turn.messages.map((message) => ({
			input: message.usage?.input,
			output: message.usage?.output,
			total: message.usage?.totalTokens,
			cost: message.usage?.cost?.total,
		}));
		const sum = (key: "input" | "output" | "total" | "cost"): number | null => {
			const items = values.map((usage) => usage[key]);
			return items.every((value): value is number => typeof value === "number" && Number.isFinite(value))
				? items.reduce((total, value) => total + value, 0)
				: null;
		};
		const inputTokens = sum("input");
		const outputTokens = sum("output");
		const totalTokens = sum("total");
		const costUsd = sum("cost");
		const usageAvailable = inputTokens !== null && outputTokens !== null;
		const measurementMs = outputTokens !== null && outputTokens > 0 && turn.generationMs > 0 ? turn.generationMs : null;
		return {
			tps: measurementMs === null ? null : round(outputTokens! / (measurementMs / 1_000), 1),
			ttftMs: turn.firstTokenMs - turn.startMs,
			totalMs: this.now() - turn.startMs,
			inputTokens,
			outputTokens,
			stallMs: turn.stallMs,
			stallCount: turn.stallCount,
			rateUsdPerMTokens: costUsd !== null && costUsd > 0 && totalTokens !== null && totalTokens > 0
				? round(costUsd / (totalTokens / 1_000_000), 2)
				: null,
			generationMs: turn.generationMs,
			totalTokens,
			costUsd,
			measurementMs,
			usageAvailable,
		};
	}

	private endAgent(): TurnPerformanceView | undefined {
		const start = this.agentStartMs;
		const turns = this.agentTurns;
		this.agentStartMs = null;
		this.agentTurns = [];
		this.turn = undefined;
		if (start === null || turns.length === 0) return;
		const sum = (key: "inputTokens" | "outputTokens" | "totalTokens" | "costUsd") =>
			turns.every((turn) => turn[key] !== null)
				? turns.reduce((total, turn) => total + turn[key]!, 0)
				: null;
		const inputTokens = sum("inputTokens");
		const outputTokens = sum("outputTokens");
		const totalTokens = sum("totalTokens");
		const costUsd = sum("costUsd");
		const usageAvailable = inputTokens !== null && outputTokens !== null;
		const generationMs = turns.reduce((total, turn) => total + turn.generationMs, 0);
		const measurementMs = outputTokens !== null && outputTokens > 0 && generationMs > 0 ? generationMs : null;
		this.lastSettled = {
			tps: measurementMs === null ? null : round(outputTokens! / (measurementMs / 1_000), 1),
			ttftMs: turns[0]!.ttftMs,
			totalMs: this.now() - start,
			inputTokens,
			outputTokens,
			stallMs: turns.reduce((total, turn) => total + turn.stallMs, 0),
			stallCount: turns.reduce((total, turn) => total + turn.stallCount, 0),
			rateUsdPerMTokens: costUsd !== null && costUsd > 0 && totalTokens !== null && totalTokens > 0
				? round(costUsd / (totalTokens / 1_000_000), 2)
				: null,
			generationMs,
			totalTokens,
			costUsd,
			measurementMs,
			usageAvailable,
		};
		return this.lastSettled;
	}
}
