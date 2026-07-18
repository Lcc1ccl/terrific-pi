/** Tracks active parent-agent wall time, including tools and child pi processes. */
export class AgentDurationTracker {
	private sessionMs = 0;
	private roundMs = 0;
	private roundStart: number | null = null;

	/** Begin a user round; repeated low-level agent starts belong to the same round. */
	startRound(now = Date.now()): void {
		if (this.roundStart !== null) return;
		this.roundMs = 0;
		this.roundStart = now;
	}

	/** End a user round when the parent agent fully settles. */
	endRound(now = Date.now()): void {
		if (this.roundStart === null) return;
		const delta = Math.max(0, now - this.roundStart);
		this.roundStart = null;
		this.roundMs += delta;
		this.sessionMs += delta;
	}

	isRunning(): boolean {
		return this.roundStart !== null;
	}

	/** Live snapshot including the active round. */
	snapshot(now = Date.now()): { roundMs: number; sessionMs: number } {
		const open = this.roundStart !== null ? Math.max(0, now - this.roundStart) : 0;
		return {
			roundMs: this.roundMs + open,
			sessionMs: this.sessionMs + open,
		};
	}

	reset(): void {
		this.sessionMs = 0;
		this.roundMs = 0;
		this.roundStart = null;
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
