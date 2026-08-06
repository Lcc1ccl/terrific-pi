import type { ClassifiableMessage, ContentPart } from "./tokens.ts";
import { charsToTokens } from "./tokens.ts";

const IMAGE_PLACEHOLDER = "[image omitted]";
const TRUNCATION_MARKER = "\n[truncated]";

function asParts(content: string | ContentPart[] | undefined): ContentPart[] {
	if (content == null) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((part) => ({ ...part }));
}

function stripImages(parts: ContentPart[]): ContentPart[] {
	const out: ContentPart[] = [];
	let omitted = false;
	for (const part of parts) {
		if (part.type === "image" || part.type === "image_url" || part.mimeType?.startsWith("image/")) {
			omitted = true;
			continue;
		}
		if (typeof part.data === "string" && part.data.length > 200) {
			omitted = true;
			continue;
		}
		out.push(part);
	}
	if (omitted) out.push({ type: "text", text: IMAGE_PLACEHOLDER });
	return out;
}

function estimateMessageTokens(message: ClassifiableMessage): number {
	let tokens = 1; // role and provider serialization overhead
	if (message.summary) tokens += charsToTokens(message.summary);
	for (const part of asParts(message.content)) {
		if (part.text) tokens += charsToTokens(part.text);
		if (part.thinking) tokens += charsToTokens(part.thinking);
		if (part.type === "toolCall" || part.type === "tool_use") {
			let serialized = part.name ?? "tool";
			try {
				serialized += JSON.stringify(part.arguments ?? {});
			} catch {
				serialized += "[args]";
			}
			tokens += charsToTokens(serialized);
		}
	}
	return tokens;
}

function sanitizeMessage(message: ClassifiableMessage): ClassifiableMessage {
	const copy: ClassifiableMessage = { ...message };
	if (copy.content != null) copy.content = stripImages(asParts(copy.content));
	return copy;
}

function textContent(message: ClassifiableMessage): string {
	return asParts(message.content)
		.map((part) => part.text ?? "")
		.filter(Boolean)
		.join("\n");
}

function truncateText(text: string, maxTokens: number): string {
	if (maxTokens <= 0) return "";
	if (charsToTokens(text) <= maxTokens) return text;

	const chars = Array.from(text);
	const marker = charsToTokens(TRUNCATION_MARKER) <= maxTokens ? TRUNCATION_MARKER : "";
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (charsToTokens(chars.slice(0, mid).join("") + marker) <= maxTokens) low = mid;
		else high = mid - 1;
	}
	return chars.slice(0, low).join("") + marker;
}

function truncateUserMessage(
	message: ClassifiableMessage,
	maxTokens: number,
): ClassifiableMessage | undefined {
	if (message.role !== "user" || maxTokens <= 1) return undefined;
	const text = truncateText(textContent(message), maxTokens - 1);
	if (!text) return undefined;
	return { ...message, content: [{ type: "text", text }] };
}

/** Each user message starts a turn; leading summaries form a leading slice. */
export function findTurnBoundaries(messages: ClassifiableMessage[]): number[] {
	const starts: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role === "user") starts.push(i);
		else if (starts.length === 0) starts.push(i);
	}
	if (starts.length === 0 && messages.length > 0) starts.push(0);
	return [...new Set(starts)];
}

/**
 * Keep the newest complete turns within a strict estimated token budget.
 * A single oversized latest turn falls back to a truncated latest user message.
 */
export function truncateMessagesForBtw(
	messages: ClassifiableMessage[],
	maxTokens: number,
): ClassifiableMessage[] {
	if (maxTokens <= 0) return [];
	const cleaned = messages.filter((message) => !message.excludeFromContext).map(sanitizeMessage);
	if (cleaned.length === 0) return [];

	const total = cleaned.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	if (total <= maxTokens) return cleaned;

	const starts = findTurnBoundaries(cleaned);
	const slices = starts.map((start, index) => {
		const end = starts[index + 1] ?? cleaned.length;
		return {
			start,
			end,
			tokens: cleaned.slice(start, end).reduce((sum, message) => sum + estimateMessageTokens(message), 0),
		};
	});

	const selected = new Map<number, ClassifiableMessage>();
	let used = 0;
	for (let index = slices.length - 1; index >= 0; index--) {
		const slice = slices[index]!;
		if (used + slice.tokens > maxTokens) {
			if (selected.size === 0) {
				for (let messageIndex = slice.end - 1; messageIndex >= slice.start; messageIndex--) {
					const truncated = truncateUserMessage(cleaned[messageIndex]!, maxTokens);
					if (truncated) {
						selected.set(messageIndex, truncated);
						used = estimateMessageTokens(truncated);
						break;
					}
				}
			}
			break;
		}

		for (let messageIndex = slice.start; messageIndex < slice.end; messageIndex++) {
			selected.set(messageIndex, cleaned[messageIndex]!);
		}
		used += slice.tokens;
	}

	const addStandalone = (messageIndex: number): void => {
		if (messageIndex < 0 || selected.has(messageIndex)) return;
		const message = cleaned[messageIndex]!;
		const remaining = maxTokens - used;
		const fullTokens = estimateMessageTokens(message);
		const candidate = fullTokens <= remaining ? message : truncateUserMessage(message, remaining);
		if (!candidate) return;
		const candidateTokens = estimateMessageTokens(candidate);
		if (candidateTokens > remaining) return;
		selected.set(messageIndex, candidate);
		used += candidateTokens;
	};

	let latestCompaction = -1;
	for (let index = cleaned.length - 1; index >= 0; index--) {
		if (cleaned[index]!.role === "compactionSummary") {
			latestCompaction = index;
			break;
		}
	}
	addStandalone(latestCompaction);
	addStandalone(cleaned.findIndex((message) => message.role === "user"));

	return [...selected.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, message]) => message);
}

export const BTW_SYSTEM_PROMPT = `你是当前编码会话的旁路解释器。

仅回答用户当前提出的问题。
依据提供的会话快照作答。
不要调用工具。
不要继续执行主任务。
不要提出新的实施计划。
不要修改任何文件。
无法从快照确认时，明确说明无法确认。
默认保持简洁。`;
