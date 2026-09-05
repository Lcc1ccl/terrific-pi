export interface FastRequestStatus {
	api?: string;
	modelId?: string;
	eligible: boolean;
	injected: boolean;
}

export function formatFastStatus(
	preferred: boolean,
	api: string | undefined,
	configPath: string,
	modelId: string | undefined,
	eligible: boolean,
	lastRequest?: FastRequestStatus,
): string {
	return [
		`Preferred: ${preferred ? "on" : "off"}`,
		`Eligible: ${eligible ? "yes" : "no"}`,
		`Injected (last provider request): ${lastRequest ? lastRequest.injected ? "yes" : "no" : "not observed"}`,
		`Current API: ${api ?? "unknown"}`,
		`Current model: ${modelId ?? "unknown"}`,
		...(lastRequest ? [`Last request: ${lastRequest.api ?? "unknown"} / ${lastRequest.modelId ?? "unknown"} · eligible ${lastRequest.eligible ? "yes" : "no"}`] : []),
		`Requires: GPT model id (gpt / gpt-* / gpt.*) on openai-family Responses`,
		`Config: ${configPath}`,
	].join("\n");
}
