export function formatFastStatus(
	preferred: boolean,
	api: string | undefined,
	configPath: string,
	modelId?: string,
): string {
	const apiOk = typeof api === "string"
		&& ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api);
	const id = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
	const gptOk = id === "gpt" || id.startsWith("gpt-") || id.startsWith("gpt.");
	const active = preferred && apiOk && gptOk;
	return [
		`Preference: ${preferred ? "on" : "off"}`,
		`Effective: ${active ? "active" : "inactive"}`,
		`Current API: ${api ?? "unknown"}`,
		`Current model: ${modelId ?? "unknown"}`,
		`Requires: GPT model id (gpt / gpt-* / gpt.*) on openai-family Responses`,
		`Config: ${configPath}`,
	].join("\n");
}
