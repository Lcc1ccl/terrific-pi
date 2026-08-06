import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";

export type AuxiliaryTaskKey =
	| "compression"
	| "title_generation"
	| "text_summary"
	| "commit_message"
	| "btw"
	| "web_research";

export type AuxiliaryExecutor = "call" | "session" | "delegation";

export type AuxiliaryErrorCode =
	| "disabled"
	| "model_not_found"
	| "auth_unavailable"
	| "unsupported_input"
	| "input_too_large"
	| "timeout"
	| "aborted"
	| "provider_error"
	| "empty_response"
	| "invalid_output";

export interface AuxiliaryRouteConfig {
	model: string | "current";
	thinking: ThinkingLevel;
	timeoutMs: number;
	maxOutputTokens: number;
	maxRetries: number;
	fallbackModels: string[];
}

export interface AuxiliaryTaskRouteConfig extends Partial<AuxiliaryRouteConfig> {
	useAuxiliary?: boolean;
}

export interface AuxiliaryConfig {
	enabled: boolean;
	default: AuxiliaryRouteConfig;
	tasks: Record<string, AuxiliaryTaskRouteConfig>;
	git: {
		confirm: boolean;
		allowHeadless: boolean;
		allowPush: boolean;
	};
}

export interface AuxiliaryCallRequest {
	task: AuxiliaryTaskKey;
	executor: AuxiliaryExecutor;
	adapter: string;
	systemPrompt?: string;
	messages: Message[];
	requiredInput: "text" | "image";
	maxOutputTokens?: number;
	signal?: AbortSignal;
	validateOutput?: (text: string, response: import("@earendil-works/pi-ai").AssistantMessage) => string;
	shouldRecordAttempt?: () => boolean;
}

export interface AuxiliaryCallResult {
	status: "ok";
	text: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	fallbackIndex: number;
	durationMs: number;
	usage: Usage;
	stopReason: import("@earendil-works/pi-ai").AssistantMessage["stopReason"];
}

export type AuxiliaryUsage = Omit<Usage, "cost"> & {
	cost?: Usage["cost"];
};

export interface AuxiliaryUsageEntryV1 {
	version: 1;
	id: string;
	task: string;
	executor: AuxiliaryExecutor;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	status: "ok" | "error" | "aborted" | "timeout";
	fallbackIndex: number;
	startedAt: number;
	durationMs: number;
	usage?: AuxiliaryUsage;
	errorCode?: AuxiliaryErrorCode;
}
