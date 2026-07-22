export const DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
export const DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

export interface DelegationEventBus {
	on(event: string, handler: (value: unknown) => void): (() => void) | void;
	emit(event: string, value: unknown): void;
}

export interface DocsDelegationRequest {
	version: 1;
	requestId: string;
	agent: string;
	task: string;
	context: "fresh";
	cwd: string;
	model?: string;
	timeoutMs: number;
	turnBudget: { maxTurns: number; graceTurns: number };
	toolBudget: { soft: number; hard: number; block: string[] };
	skill: string | false;
	output: false;
	outputMode: "inline";
	acceptance: false;
	artifacts: true;
}

export interface DocsDelegationResponse {
	version: 1;
	requestId: string;
	status: string;
	output?: string;
	error?: string;
	model?: string;
	runId?: string;
	sessionFile?: string;
	durationMs?: number;
	tokens?: number;
}

function envelope(value: unknown, requestId: string): value is { version: 1; requestId: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.version === 1 && record.requestId === requestId;
}

export function buildDocsDelegationRequest(options: {
	requestId: string;
	agent: string;
	cwd: string;
	task: string;
	model?: string;
	timeoutMs?: number;
	skill?: string | false;
}): DocsDelegationRequest {
	return {
		version: 1,
		requestId: options.requestId,
		agent: options.agent,
		task: options.task,
		context: "fresh",
		cwd: options.cwd,
		...(options.model && !options.model.startsWith("blocked/") ? { model: options.model } : {}),
		timeoutMs: options.timeoutMs ?? 900_000,
		turnBudget: { maxTurns: 12, graceTurns: 1 },
		toolBudget: {
			soft: 30,
			hard: 50,
			block: ["bash", "edit", "write", "subagent", "git_finalize", "docs_agent", "sidecar"],
		},
		skill: options.skill ?? "project-docs",
		output: false,
		outputMode: "inline",
		acceptance: false,
		artifacts: true,
	};
}

export function delegateDocsAgent(options: {
	events: DelegationEventBus;
	request: DocsDelegationRequest;
	signal?: AbortSignal;
	availabilityTimeoutMs?: number;
	onUpdate?: (value: unknown) => void;
}): Promise<DocsDelegationResponse> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const unsubscribes: Array<() => void> = [];
		const subscribe = (event: string, handler: (value: unknown) => void) => {
			const unsubscribe = options.events.on(event, handler);
			if (typeof unsubscribe === "function") unsubscribes.push(unsubscribe);
		};
		const cleanup = () => {
			clearTimeout(availabilityTimer);
			clearTimeout(completionTimer);
			options.signal?.removeEventListener("abort", onAbort);
			for (const unsubscribe of unsubscribes) unsubscribe();
		};
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			action();
		};
		const onAbort = () => {
			options.events.emit(DELEGATION_CANCEL_EVENT, { version: 1, requestId: options.request.requestId });
			finish(() => reject(new Error("Docsflow delegation cancelled")));
		};

		const availabilityTimer = setTimeout(() => {
			finish(() => reject(new Error("Docsflow delegation unavailable (is pi-subagents loaded?)")));
		}, options.availabilityTimeoutMs ?? 2_000);
		const completionTimer = setTimeout(() => {
			options.events.emit(DELEGATION_CANCEL_EVENT, { version: 1, requestId: options.request.requestId });
			finish(() => reject(new Error("Docsflow delegation timed out")));
		}, options.request.timeoutMs + 5_000);

		subscribe(DELEGATION_STARTED_EVENT, (value) => {
			if (envelope(value, options.request.requestId)) clearTimeout(availabilityTimer);
		});
		subscribe(DELEGATION_UPDATE_EVENT, (value) => {
			if (envelope(value, options.request.requestId)) options.onUpdate?.(value);
		});
		subscribe(DELEGATION_RESPONSE_EVENT, (value) => {
			if (!envelope(value, options.request.requestId)) return;
			finish(() => resolve(value as DocsDelegationResponse));
		});

		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		options.events.emit(DELEGATION_REQUEST_EVENT, options.request);
	});
}
