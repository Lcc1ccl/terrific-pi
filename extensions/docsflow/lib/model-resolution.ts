import { readFileSync } from "node:fs";

export type ResolutionStatus = "ready" | "blocked" | "approximate";

export interface ModelRequest {
	agent: string;
	requested: string;
	thinking?: string;
}

export interface ModelCatalogEntry {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
}

export interface ModelResolutionRow {
	agent: string;
	requestedName: string;
	resolvedProvider: string;
	resolvedModelId: string;
	thinking: string;
	status: ResolutionStatus;
	note?: string;
}

export const DEFAULT_MODEL_REQUESTS: ModelRequest[] = [
	{ agent: "research-analyst", requested: "grok4.5", thinking: "high" },
	{ agent: "product-architect", requested: "5.6-sol-max" },
	{ agent: "interface-designer", requested: "fable 5-max" },
	{ agent: "delivery-reviewer", requested: "5.6-sol-max" },
];

export function loadModelsCatalog(modelsJsonPath: string): ModelCatalogEntry[] {
	const data = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as {
		providers?: Record<string, { models?: Array<{ id?: string; name?: string; reasoning?: boolean }> }>;
	};
	const out: ModelCatalogEntry[] = [];
	for (const [provider, config] of Object.entries(data.providers ?? {})) {
		for (const model of config.models ?? []) {
			if (!model.id) continue;
			out.push({
				provider,
				id: model.id,
				...(model.name ? { name: model.name } : {}),
				...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
			});
		}
	}
	return out;
}

function norm(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function resolveModelRequest(request: ModelRequest, catalog: readonly ModelCatalogEntry[]): ModelResolutionRow {
	const thinking = request.thinking ?? "model-default";
	const requested = request.requested.trim();
	if (!requested) return row(request, "", "", thinking, "blocked", "Requested model is empty");

	const slash = requested.indexOf("/");
	if (slash > 0) {
		const provider = requested.slice(0, slash);
		const id = requested.slice(slash + 1);
		const exact = catalog.find((entry) => entry.provider === provider && entry.id === id);
		if (exact) return row(request, exact.provider, exact.id, thinking, "ready");
		return row(request, provider, id, thinking, "blocked", "Exact provider/model not found");
	}

	const wanted = norm(requested);
	const exactId = catalog.filter((entry) => norm(entry.id) === wanted || norm(entry.name ?? "") === wanted);
	if (exactId.length === 1) return row(request, exactId[0]!.provider, exactId[0]!.id, thinking, "ready");
	if (exactId.length > 1) {
		return row(request, "", "", thinking, "blocked", `Ambiguous exact match: ${exactId.map((e) => `${e.provider}/${e.id}`).join(", ")}`);
	}

	const approximates: Array<{ match: (n: string) => boolean; pick: (c: readonly ModelCatalogEntry[]) => ModelCatalogEntry | undefined; note: string }> = [
		{
			match: (n) => n === "grok45" || n === "grok4point5",
			pick: (c) => c.find((e) => e.provider === "grok" && e.id === "grok-4.5"),
			note: "Alias grok4.5 → grok/grok-4.5",
		},
		{
			match: (n) => n === "56solmax" || n === "56sol" || n === "gpt56solmax" || n === "gpt56sol",
			pick: (c) => c.find((e) => e.provider === "openai" && e.id === "gpt-5.6-sol"),
			note: "No 5.6-sol-max in catalog; mapped to openai/gpt-5.6-sol",
		},
	];

	for (const rule of approximates) {
		if (!rule.match(wanted)) continue;
		const hit = rule.pick(catalog);
		if (!hit) return row(request, "", "", thinking, "blocked", `${rule.note}; target missing`);
		const status: ResolutionStatus = rule.note.includes("No ") ? "approximate" : "ready";
		return row(request, hit.provider, hit.id, thinking, status, rule.note);
	}

	const contains = catalog.filter((entry) => norm(entry.id).includes(wanted) || norm(entry.name ?? "").includes(wanted));
	if (contains.length === 1) return row(request, contains[0]!.provider, contains[0]!.id, thinking, "approximate", "Single partial catalog match");
	if (contains.length > 1) {
		return row(request, "", "", thinking, "blocked", `Ambiguous partial match: ${contains.slice(0, 6).map((e) => `${e.provider}/${e.id}`).join(", ")}`);
	}
	return row(request, "", "", thinking, "blocked", "Zero catalog matches");
}

export function resolveAll(requests: readonly ModelRequest[], catalog: readonly ModelCatalogEntry[]): ModelResolutionRow[] {
	return requests.map((request) => resolveModelRequest(request, catalog));
}

export function renderModelResolutionMarkdown(rows: readonly ModelResolutionRow[]): string {
	const lines = [
		"# Model Resolution",
		"",
		"Generated for docsflow profiles. `blocked` agents must not run. `approximate` requires human confirmation.",
		"",
		"| Agent | Requested Name | Resolved Provider | Resolved Model ID | Thinking | Status | Note |",
		"|---|---|---|---|---|---|---|",
	];
	for (const row of rows) {
		lines.push(
			`| ${row.agent} | ${row.requestedName} | ${row.resolvedProvider || "-"} | ${row.resolvedModelId || "-"} | ${row.thinking} | ${row.status} | ${row.note ?? ""} |`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

function row(
	request: ModelRequest,
	provider: string,
	modelId: string,
	thinking: string,
	status: ResolutionStatus,
	note?: string,
): ModelResolutionRow {
	return {
		agent: request.agent,
		requestedName: request.requested,
		resolvedProvider: provider,
		resolvedModelId: modelId,
		thinking,
		status,
		...(note ? { note } : {}),
	};
}
