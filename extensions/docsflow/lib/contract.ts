export type ContractStatus = "completed" | "blocked" | "needs_input" | "failed";
export type ContractConfidence = "low" | "medium" | "high";

export interface ArtifactItem {
	path: string;
	content: string;
}

export interface ArtifactContract {
	status: ContractStatus;
	summary: string;
	decisions: string[];
	assumptions: string[];
	evidence: string[];
	unresolved: string[];
	risks: string[];
	recommended_next_step: string;
	artifacts: ArtifactItem[];
	confidence: ContractConfidence;
}

export class ContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContractError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new ContractError(`${field} must be an array`);
	return value.map((item, index) => {
		if (typeof item !== "string") throw new ContractError(`${field}[${index}] must be a string`);
		return item;
	});
}

export function parseArtifactContract(raw: unknown): ArtifactContract {
	if (!isRecord(raw)) throw new ContractError("Artifact contract must be an object");
	const status = raw.status;
	if (status !== "completed" && status !== "blocked" && status !== "needs_input" && status !== "failed") {
		throw new ContractError("Invalid status");
	}
	if (typeof raw.summary !== "string" || !raw.summary.trim()) throw new ContractError("summary is required");
	if (typeof raw.recommended_next_step !== "string") throw new ContractError("recommended_next_step is required");
	const confidence = raw.confidence;
	if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
		throw new ContractError("Invalid confidence");
	}
	if (!Array.isArray(raw.artifacts) || raw.artifacts.length === 0) throw new ContractError("artifacts must be a non-empty array");
	const artifacts = raw.artifacts.map((item, index) => {
		if (!isRecord(item)) throw new ContractError(`artifacts[${index}] must be an object`);
		if (typeof item.path !== "string" || !item.path.trim()) throw new ContractError(`artifacts[${index}].path is required`);
		if (typeof item.content !== "string" || !item.content.trim()) throw new ContractError(`artifacts[${index}].content is required`);
		return { path: item.path, content: item.content };
	});
	return {
		status,
		summary: raw.summary,
		decisions: stringArray(raw.decisions, "decisions"),
		assumptions: stringArray(raw.assumptions, "assumptions"),
		evidence: stringArray(raw.evidence, "evidence"),
		unresolved: stringArray(raw.unresolved, "unresolved"),
		risks: stringArray(raw.risks, "risks"),
		recommended_next_step: raw.recommended_next_step,
		artifacts,
		confidence,
	};
}

export function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) throw new ContractError("Empty agent output");
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fenced?.[1]?.trim() || trimmed;
	try {
		return JSON.parse(candidate);
	} catch {
		// fall through
	}
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) throw new ContractError("No JSON object found in agent output");
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch (error) {
		throw new ContractError(`Failed to parse artifact JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function parseContractFromText(text: string): ArtifactContract {
	return parseArtifactContract(extractJsonObject(text));
}

export function parentSummary(contract: ArtifactContract, written: string[]): string {
	return [
		`status: ${contract.status} · confidence: ${contract.confidence}`,
		`summary: ${contract.summary}`,
		contract.decisions.length ? `decisions: ${contract.decisions.join("; ")}` : "",
		contract.unresolved.length ? `unresolved: ${contract.unresolved.join("; ")}` : "",
		contract.risks.length ? `risks: ${contract.risks.join("; ")}` : "",
		contract.recommended_next_step ? `next: ${contract.recommended_next_step}` : "",
		written.length ? `files: ${written.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}
