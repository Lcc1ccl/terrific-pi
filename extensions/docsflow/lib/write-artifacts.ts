import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assertAllowlisted, resolveDraftPath, resolveInsideOutputRoot } from "./artifacts.ts";
import type { ArtifactItem } from "./contract.ts";

export interface WriteResult {
	written: string[];
	drafts: string[];
	formal: string[];
}

export function materializeArtifacts(options: {
	outputRoot: string;
	allowlist: readonly string[];
	artifacts: readonly ArtifactItem[];
}): WriteResult {
	const written: string[] = [];
	const drafts: string[] = [];
	const formal: string[] = [];
	mkdirSync(options.outputRoot, { recursive: true });

	for (const artifact of options.artifacts) {
		const requested = assertAllowlisted(artifact.path, options.allowlist);
		const absoluteRequested = resolveInsideOutputRoot(options.outputRoot, requested);
		const formalExists = existsSync(absoluteRequested);
		const relativeTarget = resolveDraftPath(requested, formalExists);
		const absoluteTarget = resolveInsideOutputRoot(options.outputRoot, relativeTarget);
		mkdirSync(path.dirname(absoluteTarget), { recursive: true });
		const tmp = `${absoluteTarget}.${process.pid}.tmp`;
		writeFileSync(tmp, artifact.content.endsWith("\n") ? artifact.content : `${artifact.content}\n`, "utf8");
		renameSync(tmp, absoluteTarget);
		written.push(relativeTarget);
		if (relativeTarget.endsWith(".draft.md")) drafts.push(relativeTarget);
		else formal.push(relativeTarget);
	}
	return { written, drafts, formal };
}

export function listDraftArtifacts(outputRoot: string): Array<{ draft: string; formal: string }> {
	if (!existsSync(outputRoot)) return [];
	const out: Array<{ draft: string; formal: string }> = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".draft.md")) continue;
			const relativeDraft = path.relative(outputRoot, full).split(path.sep).join("/");
			out.push({ draft: relativeDraft, formal: relativeDraft.replace(/\.draft\.md$/, ".md") });
		}
	};
	walk(outputRoot);
	return out.sort((a, b) => a.draft.localeCompare(b.draft));
}

export function backupAndApplyDrafts(options: {
	outputRoot: string;
	backupRoot: string;
	pairs: Array<{ draft: string; formal: string }>;
	timestamp?: string;
}): { backupDir: string; applied: string[] } {
	const stamp = options.timestamp ?? new Date().toISOString().replaceAll(":", "-");
	const backupDir = path.join(options.backupRoot, stamp);
	mkdirSync(backupDir, { recursive: true });
	const applied: string[] = [];
	for (const pair of options.pairs) {
		const draftAbs = resolveInsideOutputRoot(options.outputRoot, pair.draft);
		const formalAbs = resolveInsideOutputRoot(options.outputRoot, pair.formal);
		if (!existsSync(draftAbs)) throw new Error(`Missing draft: ${pair.draft}`);
		const backupDraft = path.join(backupDir, pair.draft);
		mkdirSync(path.dirname(backupDraft), { recursive: true });
		copyFileSync(draftAbs, backupDraft);
		if (existsSync(formalAbs)) {
			const backupFormal = path.join(backupDir, pair.formal);
			mkdirSync(path.dirname(backupFormal), { recursive: true });
			copyFileSync(formalAbs, backupFormal);
		}
		mkdirSync(path.dirname(formalAbs), { recursive: true });
		const tmp = `${formalAbs}.${process.pid}.tmp`;
		copyFileSync(draftAbs, tmp);
		renameSync(tmp, formalAbs);
		applied.push(pair.formal);
	}
	return { backupDir, applied };
}

export function draftDiffSummary(outputRoot: string, pairs: Array<{ draft: string; formal: string }>): string {
	return pairs
		.map((pair) => {
			const draftAbs = path.join(outputRoot, pair.draft);
			const formalAbs = path.join(outputRoot, pair.formal);
			const draftBytes = existsSync(draftAbs) ? statSync(draftAbs).size : 0;
			const formalBytes = existsSync(formalAbs) ? statSync(formalAbs).size : 0;
			const draftLines = existsSync(draftAbs) ? readFileSync(draftAbs, "utf8").split("\n").length : 0;
			const formalLines = existsSync(formalAbs) ? readFileSync(formalAbs, "utf8").split("\n").length : 0;
			return `${pair.formal} <= ${pair.draft} (formal ${formalLines}L/${formalBytes}B → draft ${draftLines}L/${draftBytes}B)`;
		})
		.join("\n");
}
