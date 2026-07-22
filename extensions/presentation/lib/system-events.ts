import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type {
	PresentationEvent,
	PresentationKind,
	PresentationSystemEntry,
	PresentationTone,
} from "./types.ts";

const ANSI_PATTERN = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const TONES = new Set<PresentationTone>(["info", "success", "warning", "error", "muted"]);
const EVENT_KINDS = new Set<PresentationEvent["kind"]>(["mode", "fast"]);
const SOURCES = new Set<PresentationEvent["source"]>(["user", "startup", "restore", "system"]);
const TRANSIENT_KINDS = new Set<PresentationKind>(["mode", "fast", "model", "thinking"]);
const EVENT_DEDUPE_MS = 500;

export const ANSWER_CONTRACT = [
	"Presentation contract:",
	"- The runtime already displays tool calls, task progress, and changed files. Do not narrate or repeat them.",
	"- Start the final response with the result, decision, or direct answer.",
	"- Add only the evidence, verification, risks, and next action the user needs.",
	"- Use a table only when comparison is materially easier than prose.",
	"- If the user explicitly asks for a walkthrough, explanation, report, or raw command output, honor that request instead.",
].join("\n");

export function sanitizeSystemText(value: unknown, max = 180): string {
	if (typeof value !== "string") return "";
	return stripVTControlCharacters(value)
		.replace(ANSI_PATTERN, "")
		.replace(CONTROL_PATTERN, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

export function appendAnswerContract(systemPrompt: string): string {
	return systemPrompt.includes("Presentation contract:") ? systemPrompt : `${systemPrompt}\n\n${ANSWER_CONTRACT}`;
}

export function makeSystemEntry(input: {
	kind: PresentationKind;
	tone?: PresentationTone;
	label: string;
	message: string;
	detail?: string;
	dedupeKey: string;
	timestamp?: number;
}): PresentationSystemEntry | undefined {
	const label = sanitizeSystemText(input.label, 48);
	const message = sanitizeSystemText(input.message, 180);
	const dedupeKey = sanitizeSystemText(input.dedupeKey, 180);
	if (!label || !message || !dedupeKey) return undefined;
	const detail = sanitizeSystemText(input.detail, 240);
	return {
		version: 1,
		kind: input.kind,
		tone: input.tone ?? "info",
		label,
		message,
		...(detail ? { detail } : {}),
		timestamp: input.timestamp ?? Date.now(),
		dedupeKey,
	};
}

export function makeWorkspaceEntry(input: {
	cwd: string;
	branch?: string;
	ruleCount: number;
	timestamp?: number;
}): PresentationSystemEntry | undefined {
	const workspace = basename(input.cwd.trim());
	if (!workspace) return undefined;
	const details = [workspace, sanitizeSystemText(input.branch, 80), input.ruleCount > 0 ? `rules ${input.ruleCount}` : ""]
		.filter(Boolean)
		.join(" · ");
	return makeSystemEntry({
		kind: "workspace",
		label: "WORKSPACE",
		message: details,
		dedupeKey: `workspace:${input.cwd}`,
		timestamp: input.timestamp,
	});
}

export function isPresentationSystemEntry(value: unknown): value is PresentationSystemEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Partial<PresentationSystemEntry>;
	return entry.version === 1
		&& typeof entry.kind === "string"
		&& typeof entry.label === "string"
		&& typeof entry.message === "string"
		&& typeof entry.dedupeKey === "string"
		&& typeof entry.timestamp === "number";
}

export function isPresentationEvent(value: unknown): value is PresentationEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const event = value as Partial<PresentationEvent>;
	return event.version === 1
		&& typeof event.kind === "string" && EVENT_KINDS.has(event.kind as PresentationEvent["kind"])
		&& typeof event.source === "string" && SOURCES.has(event.source as PresentationEvent["source"])
		&& typeof event.tone === "string" && TONES.has(event.tone as PresentationTone)
		&& typeof event.label === "string" && Boolean(sanitizeSystemText(event.label, 48))
		&& typeof event.message === "string" && Boolean(sanitizeSystemText(event.message, 180))
		&& typeof event.dedupeKey === "string" && Boolean(sanitizeSystemText(event.dedupeKey, 180));
}

export class EntryDeduper {
	private readonly keys = new Set<string>();
	private recentKey: string | undefined;
	private recentTimestamp: number | undefined;

	hydrate(entries: readonly unknown[]): void {
		this.keys.clear();
		this.recentKey = undefined;
		this.recentTimestamp = undefined;
		for (const entry of entries) {
			if (isPresentationSystemEntry(entry) && !TRANSIENT_KINDS.has(entry.kind)) this.keys.add(entry.dedupeKey);
		}
	}

	accept(entry: PresentationSystemEntry): boolean {
		if (TRANSIENT_KINDS.has(entry.kind)) return this.acceptRecent(entry);
		if (this.keys.has(entry.dedupeKey)) return false;
		this.keys.add(entry.dedupeKey);
		return true;
	}

	private acceptRecent(entry: PresentationSystemEntry): boolean {
		const isImmediateRepeat = this.recentKey === entry.dedupeKey
			&& this.recentTimestamp !== undefined
			&& entry.timestamp - this.recentTimestamp < EVENT_DEDUPE_MS;
		if (isImmediateRepeat) return false;
		this.recentKey = entry.dedupeKey;
		this.recentTimestamp = entry.timestamp;
		return true;
	}
}
