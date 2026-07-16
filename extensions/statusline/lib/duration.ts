/** Tracks LLM wall time only (assistant stream segments), excluding tools and idle. */
export class LlmDurationTracker {
	private sessionMs = 0;
	private roundMs = 0;
	private segmentStart: number | null = null;

	/** Begin a user round; previous open segment is closed into session first. */
	startRound(now = Date.now()): void {
		this.stopSegment(now);
		this.roundMs = 0;
	}

	/** End a user round (agent settled / aborted). */
	endRound(now = Date.now()): void {
		this.stopSegment(now);
	}

	startSegment(now = Date.now()): void {
		if (this.segmentStart !== null) return;
		this.segmentStart = now;
	}

	stopSegment(now = Date.now()): void {
		if (this.segmentStart === null) return;
		const delta = Math.max(0, now - this.segmentStart);
		this.segmentStart = null;
		this.roundMs += delta;
		this.sessionMs += delta;
	}

	isRunning(): boolean {
		return this.segmentStart !== null;
	}

	/** Live snapshot including any open segment. */
	snapshot(now = Date.now()): { roundMs: number; sessionMs: number } {
		const open = this.segmentStart !== null ? Math.max(0, now - this.segmentStart) : 0;
		return {
			roundMs: this.roundMs + open,
			sessionMs: this.sessionMs + open,
		};
	}

	reset(): void {
		this.sessionMs = 0;
		this.roundMs = 0;
		this.segmentStart = null;
	}
}

/** Compact duration: `4.2s`, `1m05s`, `1h02m03s`. */
export function formatDuration(ms: number): string {
	const clamped = Math.max(0, ms);
	if (clamped < 60_000) {
		const tenths = Math.floor(clamped / 100) / 10;
		return Number.isInteger(tenths) ? `${tenths.toFixed(0)}s` : `${tenths.toFixed(1)}s`;
	}

	const totalSec = Math.floor(clamped / 1000);
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	const ss = String(seconds).padStart(2, "0");

	if (hours > 0) {
		const mm = String(minutes).padStart(2, "0");
		return `${hours}h${mm}m${ss}s`;
	}
	return `${minutes}m${ss}s`;
}

/** `round / session` pair for the footer widget. */
export function formatDurationPair(roundMs: number, sessionMs: number, minimal = false): string {
	const left = formatDuration(roundMs);
	const right = formatDuration(sessionMs);
	return minimal ? `${left}/${right}` : `${left} / ${right}`;
}
