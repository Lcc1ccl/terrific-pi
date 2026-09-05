export type CategoryKey =
	| "system"
	| "user"
	| "assistantText"
	| "thinking"
	| "toolCalls"
	| "toolResults"
	| "compaction"
	| "branchSummary"
	| "custom"
	| "images"
	| "unclassified";

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
	system: "System Prompt",
	user: "User Messages",
	assistantText: "Assistant Text",
	thinking: "Thinking Blocks",
	toolCalls: "Tool Calls",
	toolResults: "Tool Results",
	compaction: "Compaction Summaries",
	branchSummary: "Branch Summaries",
	custom: "Custom Messages",
	images: "Images",
	unclassified: "Unclassified / Provider Overhead",
};

export interface ContentPart {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	toolName?: string;
	data?: string;
	mimeType?: string;
	source?: unknown;
}

export interface ClassifiableMessage {
	role?: string;
	content?: string | ContentPart[];
	summary?: string;
	name?: string;
	toolName?: string;
	excludeFromContext?: boolean;
	customType?: string;
}

export interface EntryEstimate {
	id: string;
	label: string;
	category: CategoryKey;
	chars: number;
	tokens: number;
	preview: string;
	toolName?: string;
}

export interface CategoryTotals {
	system: number;
	user: number;
	assistantText: number;
	thinking: number;
	toolCalls: number;
	toolResults: number;
	compaction: number;
	branchSummary: number;
	custom: number;
	images: number;
	unclassified: number;
}

export interface ContextBreakdown {
	totalTokens: number | null;
	contextWindow: number | null;
	percent: number | null;
	categories: CategoryTotals;
	entries: EntryEstimate[];
	imageCount: number;
	estimatedSum: number;
}

export interface SafeContextUsage {
	safeInputLimit: number;
	remainingTokens: number;
	percent: number;
}

/** Reserve the model's maximum output plus Pi's default response margin. */
export function safeContextUsage(
	tokens: number | null,
	contextWindow: number | null,
	maxOutputTokens: number | undefined,
	reserveTokens = 16_384,
): SafeContextUsage | undefined {
	if (tokens === null || contextWindow === null || maxOutputTokens === undefined) return undefined;
	if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || !Number.isFinite(maxOutputTokens) || !Number.isFinite(reserveTokens)) return undefined;
	const safeInputLimit = contextWindow - Math.max(0, maxOutputTokens) - Math.max(0, reserveTokens);
	if (safeInputLimit <= 0) return undefined;
	return {
		safeInputLimit,
		remainingTokens: Math.max(0, safeInputLimit - tokens),
		percent: Math.round((tokens / safeInputLimit) * 1_000) / 10,
	};
}

const CJK_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;

/** Rough text token estimate: CJK ~1 char, code/JSON ~3 chars, other text ~4 chars. */
export function charsToTokens(value: number | string): number {
	if (typeof value === "number") return value > 0 ? Math.ceil(value / 4) : 0;
	if (!value) return 0;

	let cjk = 0;
	let other = 0;
	for (const char of value) {
		if (CJK_CHARACTER.test(char)) cjk += 1;
		else other += 1;
	}
	const structured = /```|[{}[\];]|=>|:=/.test(value.trim());
	return cjk + Math.ceil(other / (structured ? 3 : 4));
}

function contentParts(content: string | ContentPart[] | undefined): ContentPart[] {
	if (content == null) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content;
}

function textValues(parts: ContentPart[]): string[] {
	return parts.flatMap((part) => {
		if (part.type === "text" && part.text) return [part.text];
		if (typeof part.text === "string" && !part.type) return [part.text];
		return [];
	});
}

function textChars(parts: ContentPart[]): number {
	return textValues(parts).reduce((sum, text) => sum + text.length, 0);
}

function textTokens(parts: ContentPart[]): number {
	return textValues(parts).reduce((sum, text) => sum + charsToTokens(text), 0);
}

function thinkingValues(parts: ContentPart[]): string[] {
	return parts.flatMap((part) => (part.type === "thinking" && part.thinking ? [part.thinking] : []));
}

function thinkingChars(parts: ContentPart[]): number {
	return thinkingValues(parts).reduce((sum, text) => sum + text.length, 0);
}

function thinkingTokens(parts: ContentPart[]): number {
	return thinkingValues(parts).reduce((sum, text) => sum + charsToTokens(text), 0);
}

function toolCallStats(parts: ContentPart[]): { chars: number; tokens: number; names: string[] } {
	let chars = 0;
	let tokens = 0;
	const names: string[] = [];
	for (const part of parts) {
		if (part.type === "toolCall" || part.type === "tool_use") {
			const name = part.name ?? "tool";
			let serialized = name;
			names.push(name);
			try {
				serialized += JSON.stringify(part.arguments ?? {});
			} catch {
				serialized += "[args]";
			}
			chars += serialized.length;
			tokens += charsToTokens(serialized);
		}
	}
	return { chars, tokens, names };
}

function imageCountIn(parts: ContentPart[]): number {
	let n = 0;
	for (const part of parts) {
		if (part.type === "image" || part.type === "image_url" || part.mimeType?.startsWith("image/")) n += 1;
	}
	return n;
}

function firstText(parts: ContentPart[], fallback = ""): string {
	for (const part of parts) {
		if (part.type === "text" && part.text) return part.text;
		if (part.thinking) return part.thinking;
	}
	return fallback;
}

function emptyCategories(): CategoryTotals {
	return {
		system: 0,
		user: 0,
		assistantText: 0,
		thinking: 0,
		toolCalls: 0,
		toolResults: 0,
		compaction: 0,
		branchSummary: 0,
		custom: 0,
		images: 0,
		unclassified: 0,
	};
}

/** Classify session messages + system prompt into estimated token buckets. */
export function analyzeContext(options: {
	systemPrompt?: string;
	messages: ClassifiableMessage[];
	totalTokens?: number | null;
	contextWindow?: number | null;
	percent?: number | null;
	imageTokenEstimate?: number;
}): ContextBreakdown {
	const categories = emptyCategories();
	const entries: EntryEstimate[] = [];
	let imageCount = 0;
	const imageTokenEstimate = options.imageTokenEstimate ?? 1000;

	if (options.systemPrompt) {
		const chars = options.systemPrompt.length;
		const tokens = charsToTokens(options.systemPrompt);
		categories.system += tokens;
		entries.push({
			id: "system",
			label: "system prompt",
			category: "system",
			chars,
			tokens,
			preview: options.systemPrompt,
		});
	}

	let index = 0;
	for (const message of options.messages) {
		if (message.excludeFromContext) continue;
		const role = message.role ?? "unknown";
		const parts = contentParts(message.content);
		const id = `msg-${index++}`;

		if (role === "user") {
			const chars = textChars(parts);
			const imgs = imageCountIn(parts);
			const contentTokens = textTokens(parts);
			imageCount += imgs;
			const tokens = contentTokens + imgs * imageTokenEstimate;
			categories.user += contentTokens;
			categories.images += imgs * imageTokenEstimate;
			entries.push({
				id,
				label: "user",
				category: "user",
				chars,
				tokens,
				preview: firstText(parts),
			});
			continue;
		}

		if (role === "assistant") {
			const text = textChars(parts);
			const think = thinkingChars(parts);
			const tools = toolCallStats(parts);
			const textTokenCount = textTokens(parts);
			const thinkTokenCount = thinkingTokens(parts);
			categories.assistantText += textTokenCount;
			categories.thinking += thinkTokenCount;
			categories.toolCalls += tools.tokens;
			if (textTokenCount > 0) {
				entries.push({
					id: `${id}-text`,
					label: "assistant",
					category: "assistantText",
					chars: text,
					tokens: textTokenCount,
					preview: firstText(parts),
				});
			}
			if (thinkTokenCount > 0) {
				entries.push({
					id: `${id}-think`,
					label: "thinking",
					category: "thinking",
					chars: think,
					tokens: thinkTokenCount,
					preview: parts.find((p) => p.type === "thinking")?.thinking ?? "",
				});
			}
			if (tools.tokens > 0) {
				entries.push({
					id: `${id}-tools`,
					label: `toolCall ${tools.names.join(",") || "tool"}`,
					category: "toolCalls",
					chars: tools.chars,
					tokens: tools.tokens,
					preview: tools.names.join(", "),
					toolName: tools.names[0],
				});
			}
			continue;
		}

		if (role === "toolResult" || role === "tool") {
			const chars = textChars(parts) || (typeof message.content === "string" ? message.content.length : 0);
			const imgs = imageCountIn(parts);
			const contentTokens = textTokens(parts);
			imageCount += imgs;
			const safeChars = chars;
			const tokens = contentTokens + imgs * imageTokenEstimate;
			const toolName = message.toolName ?? message.name ?? "tool";
			categories.toolResults += contentTokens;
			categories.images += imgs * imageTokenEstimate;
			entries.push({
				id,
				label: `toolResult ${toolName}`,
				category: "toolResults",
				chars: safeChars,
				tokens,
				preview: firstText(parts),
				toolName,
			});
			continue;
		}

		if (role === "compactionSummary") {
			const summary = message.summary ?? firstText(parts);
			const chars = summary.length;
			const tokens = charsToTokens(summary);
			categories.compaction += tokens;
			entries.push({
				id,
				label: "compaction",
				category: "compaction",
				chars,
				tokens,
				preview: summary,
			});
			continue;
		}

		if (role === "branchSummary") {
			const summary = message.summary ?? firstText(parts);
			const chars = summary.length;
			const tokens = charsToTokens(summary);
			categories.branchSummary += tokens;
			entries.push({
				id,
				label: "branch summary",
				category: "branchSummary",
				chars,
				tokens,
				preview: summary,
			});
			continue;
		}

		if (role === "custom") {
			const chars = textChars(parts) || (message.summary?.length ?? 0);
			const tokens = textTokens(parts) || charsToTokens(message.summary ?? "");
			categories.custom += tokens;
			entries.push({
				id,
				label: `custom ${message.customType ?? ""}`.trim(),
				category: "custom",
				chars,
				tokens,
				preview: firstText(parts, message.summary ?? ""),
			});
			continue;
		}

		// Unknown roles: still estimate into unclassified entry list via text
		const chars = textChars(parts) + (message.summary?.length ?? 0);
		const tokens = textTokens(parts) + charsToTokens(message.summary ?? "");
		categories.unclassified += tokens;
		entries.push({
			id,
			label: role,
			category: "unclassified",
			chars,
			tokens,
			preview: firstText(parts, message.summary ?? ""),
		});
	}

	const estimatedSum =
		categories.system +
		categories.user +
		categories.assistantText +
		categories.thinking +
		categories.toolCalls +
		categories.toolResults +
		categories.compaction +
		categories.branchSummary +
		categories.custom +
		categories.images +
		categories.unclassified;

	const totalTokens = options.totalTokens ?? null;
	if (totalTokens != null && totalTokens > estimatedSum) {
		categories.unclassified += totalTokens - estimatedSum;
	}

	return {
		totalTokens,
		contextWindow: options.contextWindow ?? null,
		percent: options.percent ?? null,
		categories,
		entries,
		imageCount,
		estimatedSum,
	};
}

export function topEntries(entries: EntryEstimate[], n: number): EntryEstimate[] {
	return [...entries].sort((a, b) => b.tokens - a.tokens).slice(0, Math.max(0, n));
}

export function formatToken(n: number, estimated = true): string {
	const body = n.toLocaleString("en-US");
	return estimated ? `~${body}` : body;
}
