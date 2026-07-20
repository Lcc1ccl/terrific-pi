export function formatFastStatus(preferred: boolean, api: string | undefined, configPath: string): string {
	const active = preferred && ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api ?? "");
	return [
		`Preference: ${preferred ? "on" : "off"}`,
		`Effective: ${active ? "active" : "inactive"}`,
		`Current API: ${api ?? "unknown"}`,
		`Config: ${configPath}`,
	].join("\n");
}
