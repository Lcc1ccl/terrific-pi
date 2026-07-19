import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter, parseFrontmatterList } from "./frontmatter.ts";

export const REQUIRED_AGENTS = [
	"research-analyst",
	"product-architect",
	"interface-designer",
	"delivery-reviewer",
] as const;

export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const FORBIDDEN_TOOLS = new Set(["write", "edit", "bash", "subagent", "docs_agent", "sidecar", "git_finalize"]);

export interface DocsAgentProfile {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools: string[];
	skills: string[];
	artifactAllowlist: string[];
	timeoutSeconds?: number;
	maxTurns?: number;
	filePath: string;
	body: string;
}

export function packageRoot(from = fileURLToPath(import.meta.url)): string {
	return path.resolve(path.dirname(from), "..");
}

export function loadDocsAgentProfiles(agentsDir?: string): DocsAgentProfile[] {
	const dir = agentsDir ?? path.join(packageRoot(), "agents");
	const files = readdirSync(dir).filter((name) => name.endsWith(".md") && !name.endsWith(".chain.md")).sort();
	return files.map((name) => loadProfile(path.join(dir, name)));
}

export function loadProfile(filePath: string): DocsAgentProfile {
	const content = readFileSync(filePath, "utf8");
	const { frontmatter, body } = parseFrontmatter(content);
	const name = frontmatter.name?.trim();
	const description = frontmatter.description?.trim();
	if (!name || !description) throw new Error(`Invalid agent profile: ${filePath}`);
	const tools = parseFrontmatterList(frontmatter.tools);
	const skills = parseFrontmatterList(frontmatter.skill ?? frontmatter.skills);
	const artifactAllowlist = parseFrontmatterList(frontmatter.artifact_allowlist);
	const timeoutSeconds = frontmatter.timeout_seconds ? Number(frontmatter.timeout_seconds) : undefined;
	const maxTurns = frontmatter.max_turns ? Number(frontmatter.max_turns) : undefined;
	return {
		name,
		description,
		...(frontmatter.model ? { model: frontmatter.model.trim() } : {}),
		...(frontmatter.thinking ? { thinking: frontmatter.thinking.trim() } : {}),
		tools,
		skills,
		artifactAllowlist,
		...(timeoutSeconds !== undefined && Number.isFinite(timeoutSeconds) ? { timeoutSeconds } : {}),
		...(maxTurns !== undefined && Number.isFinite(maxTurns) ? { maxTurns } : {}),
		filePath,
		body,
	};
}

export function validateProfile(profile: DocsAgentProfile): string[] {
	const errors: string[] = [];
	if (!profile.tools.length) errors.push(`${profile.name}: tools must be explicit`);
	for (const tool of profile.tools) {
		if (!READ_ONLY_TOOLS.has(tool)) errors.push(`${profile.name}: tool not read-only: ${tool}`);
		if (FORBIDDEN_TOOLS.has(tool)) errors.push(`${profile.name}: forbidden tool: ${tool}`);
	}
	if (!profile.skills.includes("project-docs")) errors.push(`${profile.name}: must include skill project-docs`);
	if (!profile.artifactAllowlist.length) errors.push(`${profile.name}: artifact_allowlist is empty`);
	for (const item of profile.artifactAllowlist) {
		if (item.startsWith("/") || /^[A-Za-z]:/.test(item)) errors.push(`${profile.name}: allowlist path must be relative: ${item}`);
		if (item.includes("..")) errors.push(`${profile.name}: allowlist path traversal: ${item}`);
	}
	if (!profile.body.trim()) errors.push(`${profile.name}: system prompt body is empty`);
	return errors;
}
