import { spawn } from "node:child_process";

import { commandArgs, PILOT_VERIFICATION_TIMEOUT_MS } from "./envelope.ts";

export type PilotReviewVerdict = "pass" | "fail" | "needs_decision";

export interface PilotWorkerReport {
	summary: string;
	changedFiles: string[];
	residualRisks: string[];
}

export interface PilotAcceptanceEvidence {
	criterion: string;
	evidence: string;
}

export interface PilotReviewResult {
	verdict: PilotReviewVerdict;
	findings: string[];
	validationGaps: string[];
	scopeDrift: string[];
	residualRisks: string[];
	evidence: string[];
	acceptanceEvidence: PilotAcceptanceEvidence[];
}

export interface VerificationEvidence {
	command: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	termination?: "cancelled" | "timed_out" | "spawn_error";
	error?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

function parseJson(output: string, label: string): Record<string, unknown> {
	const trimmed = output.trim();
	if (!trimmed) throw new Error(`${label} returned no output.`);
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const candidate = fenced ?? trimmed;
	try {
		return record(JSON.parse(candidate), label);
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start < 0 || end <= start) throw new Error(`${label} did not return a JSON object.`);
		try {
			return record(JSON.parse(candidate.slice(start, end + 1)), label);
		} catch (error) {
			throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function nonEmptyText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	return value.trim();
}

function stringList(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`${label} must be a string array.`);
	}
	return [...new Set(value.map((item) => (item as string).trim()))];
}

function normalizeProjectPath(value: string): string {
	const normalized = value.replaceAll("\\", "/").trim();
	if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new Error("Pilot worker changedFiles must be project-relative paths.");
	}
	return normalized.replace(/^\.\//, "");
}

function acceptanceEvidence(value: unknown): PilotAcceptanceEvidence[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("Pilot reviewer acceptanceEvidence must be a non-empty array.");
	const entries = value.map((item) => {
		const entry = record(item, "Pilot reviewer acceptanceEvidence entry");
		const unsupported = Object.keys(entry).find((key) => key !== "criterion" && key !== "evidence");
		if (unsupported) throw new Error(`Pilot reviewer acceptanceEvidence returned unsupported field: ${unsupported}.`);
		return {
			criterion: nonEmptyText(entry.criterion, "Pilot reviewer acceptance criterion"),
			evidence: nonEmptyText(entry.evidence, "Pilot reviewer acceptance evidence"),
		};
	});
	if (new Set(entries.map((entry) => entry.criterion)).size !== entries.length) {
		throw new Error("Pilot reviewer acceptanceEvidence must not contain duplicate criteria.");
	}
	return entries;
}

export function parsePilotWorkerReport(output: string): PilotWorkerReport {
	const value = parseJson(output, "Pilot worker");
	const supported = new Set(["summary", "changedFiles", "residualRisks"]);
	const unsupported = Object.keys(value).find((key) => !supported.has(key));
	if (unsupported) throw new Error(`Pilot worker returned unsupported field: ${unsupported}.`);
	const changedFiles = stringList(value.changedFiles, "Pilot worker changedFiles").map(normalizeProjectPath).sort();
	if (new Set(changedFiles).size !== changedFiles.length) throw new Error("Pilot worker changedFiles must not contain duplicates.");
	return {
		summary: nonEmptyText(value.summary, "Pilot worker summary"),
		changedFiles,
		residualRisks: stringList(value.residualRisks, "Pilot worker residualRisks"),
	};
}

export function parsePilotReviewResult(output: string): PilotReviewResult {
	const value = parseJson(output, "Pilot reviewer");
	const supported = new Set(["verdict", "findings", "validationGaps", "scopeDrift", "residualRisks", "evidence", "acceptanceEvidence"]);
	const unsupported = Object.keys(value).find((key) => !supported.has(key));
	if (unsupported) throw new Error(`Pilot reviewer returned unsupported field: ${unsupported}.`);
	if (value.verdict !== "pass" && value.verdict !== "fail" && value.verdict !== "needs_decision") {
		throw new Error("Pilot reviewer verdict is invalid.");
	}
	const result: PilotReviewResult = {
		verdict: value.verdict,
		findings: stringList(value.findings, "Pilot reviewer findings"),
		validationGaps: stringList(value.validationGaps, "Pilot reviewer validationGaps"),
		scopeDrift: stringList(value.scopeDrift, "Pilot reviewer scopeDrift"),
		residualRisks: stringList(value.residualRisks, "Pilot reviewer residualRisks"),
		evidence: stringList(value.evidence, "Pilot reviewer evidence"),
		acceptanceEvidence: acceptanceEvidence(value.acceptanceEvidence),
	};
	if (result.verdict === "pass" && (result.findings.length || result.validationGaps.length || result.scopeDrift.length)) {
		throw new Error("Pilot reviewer pass verdict cannot include findings, validation gaps, or scope drift.");
	}
	return result;
}

export function assertPilotAcceptanceEvidence(expected: readonly string[], result: PilotReviewResult): void {
	const expectedCriteria = [...new Set(expected)];
	const actualCriteria = result.acceptanceEvidence.map((entry) => entry.criterion);
	if (expectedCriteria.length !== expected.length || actualCriteria.length !== expectedCriteria.length
		|| expectedCriteria.some((criterion) => !actualCriteria.includes(criterion))
		|| actualCriteria.some((criterion) => !expectedCriteria.includes(criterion))) {
		throw new Error("Pilot reviewer acceptance evidence does not exactly match the approved acceptance criteria.");
	}
}

function boundedAppend(current: string, chunk: Buffer, maximumBytes: number): string {
	const next = Buffer.concat([Buffer.from(current), chunk]);
	return next.byteLength <= maximumBytes ? next.toString("utf8") : next.subarray(next.byteLength - maximumBytes).toString("utf8");
}

export function runPilotVerification(options: {
	command: string;
	cwd: string;
	signal?: AbortSignal;
	maximumOutputBytes?: number;
	timeoutMs?: number;
}): Promise<VerificationEvidence> {
	if (options.signal?.aborted) return Promise.reject(new Error("Pilot verification cancelled before launch."));
	const timeoutMs = options.timeoutMs ?? PILOT_VERIFICATION_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("Pilot verification timeout must be a positive integer."));
	const parsed = commandArgs(options.command);
	const maximumOutputBytes = options.maximumOutputBytes ?? 64 * 1024;
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const detached = process.platform !== "win32";
		const child = spawn(parsed.command, parsed.args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let termination: "cancelled" | "timed_out" | undefined;
		let leaderClosed = false;
		let windowsTreeKilled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let groupPollTimer: ReturnType<typeof setTimeout> | undefined;
		let windowsRetryTimer: ReturnType<typeof setTimeout> | undefined;
		const deadlineTimer = setTimeout(() => beginTermination("timed_out"), timeoutMs);
		const cleanup = () => {
			options.signal?.removeEventListener("abort", onAbort);
			clearTimeout(deadlineTimer);
			if (killTimer) clearTimeout(killTimer);
			if (groupPollTimer) clearTimeout(groupPollTimer);
			if (windowsRetryTimer) clearTimeout(windowsRetryTimer);
		};
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			action();
		};
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (detached && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				try { child.kill(signal); } catch {}
			}
		};
		const processGroupAlive = (): boolean => {
			if (process.platform === "win32") return !windowsTreeKilled;
			if (!detached) return !leaderClosed;
			if (!child.pid) return !leaderClosed;
			try {
				process.kill(-child.pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const evidence = (exitCode: number | null, terminal?: Pick<VerificationEvidence, "termination" | "error">): VerificationEvidence => ({
			command: options.command,
			exitCode,
			stdout,
			stderr,
			durationMs: Date.now() - startedAt,
			...(terminal?.termination ? { termination: terminal.termination } : {}),
			...(terminal?.error ? { error: terminal.error } : {}),
		});
		const finishTerminatedAfterGroupExit = (): void => {
			if (!processGroupAlive()) {
				const error = termination === "timed_out"
					? `Pilot verification timed out after ${timeoutMs} ms.`
					: "Pilot verification cancelled.";
				finish(() => resolve(evidence(null, { termination: termination!, error })));
				return;
			}
			groupPollTimer = setTimeout(finishTerminatedAfterGroupExit, 20);
		};
		const killWindowsTree = (): void => {
			if (!child.pid || settled || windowsTreeKilled) return;
			const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			let handled = false;
			const retry = () => {
				if (handled) return;
				handled = true;
				windowsRetryTimer = setTimeout(killWindowsTree, 100);
			};
			killer.once("error", retry);
			killer.once("close", (exitCode) => {
				if (handled) return;
				handled = true;
				if (exitCode === 0) {
					windowsTreeKilled = true;
					finishTerminatedAfterGroupExit();
					return;
				}
				windowsRetryTimer = setTimeout(killWindowsTree, 100);
			});
		};
		function beginTermination(reason: "cancelled" | "timed_out"): void {
			if (termination || settled) return;
			termination = reason;
			if (process.platform === "win32") {
				killWindowsTree();
				return;
			}
			kill("SIGTERM");
			killTimer = setTimeout(() => {
				kill("SIGKILL");
				finishTerminatedAfterGroupExit();
			}, 1_000);
		}
		const onAbort = () => beginTermination("cancelled");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk, maximumOutputBytes); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk, maximumOutputBytes); });
		child.once("error", (error) => {
			leaderClosed = true;
			if (termination) {
				if (process.platform === "win32" && !child.pid) windowsTreeKilled = true;
				finishTerminatedAfterGroupExit();
				return;
			}
			finish(() => resolve(evidence(null, {
				termination: "spawn_error",
				error: error instanceof Error ? error.message : String(error),
			})));
		});
		child.once("close", (exitCode) => {
			leaderClosed = true;
			if (termination) {
				if (!processGroupAlive()) finishTerminatedAfterGroupExit();
				return;
			}
			finish(() => resolve(evidence(exitCode)));
		});
		if (options.signal?.aborted) onAbort();
	});
}
