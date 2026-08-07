import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { CompatibilityTheme } from "./user-message.ts";

type OriginalRender = (this: unknown, width: number) => string[];

interface AssistantMessageLike {
	role?: unknown;
	content?: unknown;
	usage?: unknown;
}

interface AssistantComponentLike {
	contentContainer?: { children?: unknown[] };
	hideThinkingBlock?: unknown;
	hiddenThinkingLabel?: unknown;
	isStreaming?: unknown;
	lastMessage?: AssistantMessageLike;
	outputPad?: unknown;
}

interface StreamSample {
	at: number;
	rate: number;
}

interface StreamState {
	streaming: boolean;
	frame: number;
	tokens: number;
	previousTokens?: number;
	previousAt?: number;
	samples: StreamSample[];
}

export interface AssistantRenderOptions {
	isEnabled(): boolean;
	getTheme(): CompatibilityTheme | undefined;
	now(): number;
}

export interface AssistantRenderController {
	start(message: unknown): void;
	update(message: unknown): void;
	end(message: unknown): void;
	reset(): void;
	render(instance: unknown, width: number, original: OriginalRender): string[];
}

// Adapted from Oh My Pi 17.2.10 under MIT; see ../LICENSES/oh-my-pi-MIT.txt.
const THINKING_FRAMES = ["✻", "✼", "❉", "❊", "✺", "✹", "✸", "✶"] as const;
const PROMPT_ZONE_PATTERN = /\x1b\](?:133|633);[A-Z](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;
const SPEED_WINDOW_MS = 3_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantMessage(value: unknown): AssistantMessageLike | undefined {
	return isRecord(value) && value.role === "assistant" ? value : undefined;
}

function messageObject(value: unknown): object | undefined {
	return assistantMessage(value) as object | undefined;
}

function usageTokens(message: AssistantMessageLike): number {
	if (!isRecord(message.usage)) return 0;
	const output = message.usage.output;
	const reasoning = message.usage.reasoning;
	if (typeof output === "number" && Number.isFinite(output) && output > 0) return output;
	return typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning > 0 ? reasoning : 0;
}

function formatCount(value: number): string {
	if (value < 1_000) return String(Math.floor(value));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function color(theme: CompatibilityTheme | undefined, tone: string, value: string): string {
	try {
		return theme ? theme.fg(tone, value) : value;
	} catch {
		return value;
	}
}

function splitPromptZones(lines: readonly string[]): { lines: string[]; start: string; end: string } {
	const starts: string[] = [];
	const ends: string[] = [];
	const clean = lines.map((line) => line.replace(PROMPT_ZONE_PATTERN, (marker) => {
		if (/;(?:A)(?:;|\x07|\x1b\\)/.test(marker)) starts.push(marker);
		else ends.push(marker);
		return "";
	}));
	return { lines: clean, start: starts.join(""), end: ends.join("") };
}

function thinkingShape(message: AssistantMessageLike): { runs: number; tail?: "thinking" | "text"; hasToolCall: boolean } {
	if (!Array.isArray(message.content)) return { runs: 0, hasToolCall: false };
	let runs = 0;
	let inThinking = false;
	let tail: "thinking" | "text" | undefined;
	let hasToolCall = false;
	for (const value of message.content) {
		if (!isRecord(value)) continue;
		if (value.type === "toolCall") {
			hasToolCall = true;
			inThinking = false;
			continue;
		}
		if (value.type === "thinking" && typeof value.thinking === "string" && value.thinking.trim()) {
			if (!inThinking) runs += 1;
			inThinking = true;
			tail = "thinking";
			continue;
		}
		inThinking = false;
		if (value.type === "text" && typeof value.text === "string" && value.text.trim()) tail = "text";
	}
	return { runs, tail, hasToolCall };
}

function averageSpeed(state: StreamState, now: number): number {
	state.samples = state.samples.filter((sample) => now - sample.at <= SPEED_WINDOW_MS);
	if (state.samples.length === 0) return 0;
	return state.samples.reduce((sum, sample) => sum + sample.rate, 0) / state.samples.length;
}

function pulseLine(
	state: StreamState | undefined,
	width: number,
	padding: number,
	theme: CompatibilityTheme | undefined,
	now: number,
): string {
	const frame = THINKING_FRAMES[(state?.frame ?? 0) % THINKING_FRAMES.length] ?? "✻";
	let value = `${color(theme, "thinkingText", frame)}${color(theme, "muted", " Thinking")}`;
	if (state && state.tokens > 0) value += color(theme, "dim", ` · ${formatCount(state.tokens)}`);
	const speed = state ? averageSpeed(state, now) : 0;
	if (speed >= 0.05) value += color(theme, "muted", ` · ${speed.toFixed(1)} toks/s`);
	return truncateToWidth(`${" ".repeat(Math.max(0, padding))}${value}`, Math.max(1, width), "…");
}

function hiddenThinkingRows(instance: AssistantComponentLike, width: number, label: string): number[] {
	const children = instance.contentContainer?.children;
	if (!Array.isArray(children)) return [];
	const rows: number[] = [];
	let offset = 0;
	let removeNextSpacer = false;
	for (const value of children) {
		const child = value as { constructor?: { name?: string }; text?: unknown; render?: (width: number) => readonly string[] };
		if (typeof child.render !== "function") return [];
		const rendered = child.render(width);
		if (!Array.isArray(rendered)) return [];
		const name = child.constructor?.name;
		const hiddenLabel = name === "Text" && typeof child.text === "string"
			&& stripVTControlCharacters(child.text).trim() === label;
		const remove = hiddenLabel || (removeNextSpacer && name === "Spacer");
		if (remove) {
			for (let index = 0; index < rendered.length; index += 1) rows.push(offset + index);
		}
		removeNextSpacer = hiddenLabel;
		offset += rendered.length;
	}
	return rows;
}

function removeNativeLeadingSpacer(lines: string[]): string[] {
	return lines.length > 0 && visibleWidth(lines[0] ?? "") === 0 ? lines.slice(1) : lines;
}

export function createAssistantRenderController(options: AssistantRenderOptions): AssistantRenderController {
	let states = new WeakMap<object, StreamState>();
	let active: StreamState | undefined;

	const associate = (message: unknown, state: StreamState): void => {
		const object = messageObject(message);
		if (object) states.set(object, state);
	};

	return {
		start(message) {
			if (!assistantMessage(message)) return;
			active = { streaming: true, frame: 0, tokens: 0, samples: [] };
			associate(message, active);
		},
		update(message) {
			const value = assistantMessage(message);
			if (!value) return;
			active ??= { streaming: true, frame: 0, tokens: 0, samples: [] };
			active.streaming = true;
			active.frame += 1;
			const now = options.now();
			const tokens = usageTokens(value);
			if (active.previousTokens !== undefined && active.previousAt !== undefined && tokens > active.previousTokens && now > active.previousAt) {
				active.samples.push({ at: now, rate: ((tokens - active.previousTokens) / (now - active.previousAt)) * 1_000 });
			}
			active.tokens = tokens;
			active.previousTokens = tokens;
			active.previousAt = now;
			averageSpeed(active, now);
			associate(message, active);
		},
		end(message) {
			const value = assistantMessage(message);
			if (!value) return;
			const object = value as object;
			const state = states.get(object) ?? active;
			if (state) {
				state.streaming = false;
				states.set(object, state);
			}
			active = undefined;
		},
		reset() {
			active = undefined;
			states = new WeakMap<object, StreamState>();
		},
		render(instanceValue, width, original) {
			const safeWidth = Math.max(0, Math.floor(width));
			if (!options.isEnabled()) return original.call(instanceValue, safeWidth);
			const native = original.call(instanceValue, safeWidth);
			try {
				const instance = instanceValue as AssistantComponentLike;
				const message = assistantMessage(instance.lastMessage);
				if (!message || !Array.isArray(native)) return native;

				const zones = splitPromptZones(native);
				let lines = zones.lines;
				const shape = thinkingShape(message);
				if (instance.hideThinkingBlock === true && shape.runs > 0) {
					const label = typeof instance.hiddenThinkingLabel === "string" ? instance.hiddenThinkingLabel : "Thinking...";
					const candidates = hiddenThinkingRows(instance, safeWidth, label);
					const hidden = new Set(candidates);
					const object = messageObject(message);
					const state = object ? states.get(object) : undefined;
					const streaming = state?.streaming === true || instance.isStreaming === true;
					const showPulse = streaming && !shape.hasToolCall && shape.tail === "thinking";
					const pulseIndex = showPulse ? candidates.at(-1) : undefined;
					const next: string[] = [];
					for (let index = 0; index < lines.length; index += 1) {
						if (!hidden.has(index)) next.push(lines[index] ?? "");
						else if (index === pulseIndex) {
							next.push(pulseLine(state, safeWidth, typeof instance.outputPad === "number" ? instance.outputPad : 1, options.getTheme(), options.now()));
						}
					}
					if (showPulse && pulseIndex === undefined) {
						next.unshift(pulseLine(state, safeWidth, typeof instance.outputPad === "number" ? instance.outputPad : 1, options.getTheme(), options.now()));
					}
					lines = next;
				}

				lines = removeNativeLeadingSpacer(lines);
				if (lines.length === 0) {
					const markerCarrier = zones.start + zones.end;
					return markerCarrier ? [markerCarrier] : [];
				}
				if (zones.end) lines[lines.length - 1] = zones.end + lines[lines.length - 1];
				if (zones.start) lines[0] = zones.start + lines[0];
				return lines;
			} catch {
				return native;
			}
		},
	};
}
