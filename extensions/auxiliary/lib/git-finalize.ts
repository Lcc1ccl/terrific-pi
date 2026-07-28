import { createHash } from "node:crypto";

import { validateCommitSubject } from "./prompts.ts";

export type GitFinalizeErrorCode =
	| "not_git_repo"
	| "no_staged_changes"
	| "inspection_failed"
	| "headless_denied"
	| "push_disabled"
	| "detached_head"
	| "no_upstream"
	| "invalid_subject"
	| "cancelled"
	| "staged_changed"
	| "commit_failed";

export class GitFinalizeError extends Error {
	readonly code: GitFinalizeErrorCode;

	constructor(code: GitFinalizeErrorCode, message: string) {
		super(message);
		this.name = "GitFinalizeError";
		this.code = code;
	}
}

export interface GitExecResult {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
}

export type GitExec = (
	command: string,
	args: string[],
	options: { cwd: string; timeout?: number; signal?: AbortSignal },
) => Promise<GitExecResult>;

export interface GitMetadata {
	root: string;
	branch?: string;
	upstream?: string;
	nameStatus: string;
	stat: string;
	recentSubjects: string[];
	fileCount: number;
	fingerprint: string;
}

export interface GitFinalizeConfig {
	confirm: boolean;
	allowHeadless: boolean;
	allowPush: boolean;
}

export interface GitFinalizeResult {
	status: "committed" | "pushed" | "partial";
	commit: string;
	message: string;
	branch?: string;
	upstream?: string;
	pushError?: string;
}

export interface FinalizationToolLock {
	isLocked(): boolean;
	lock(): boolean;
	restore(): void;
}

export function createFinalizationToolLock(
	getActiveTools: () => readonly string[],
	setActiveTools: (tools: readonly string[]) => void,
): FinalizationToolLock {
	let locked = false;
	let saved: string[] | undefined;
	return {
		isLocked: () => locked,
		lock() {
			if (locked) return false;
			locked = true;
			try {
				saved = [...getActiveTools()];
				setActiveTools([]);
			} catch {
				saved = undefined;
			}
			return true;
		},
		restore() {
			if (!locked) return;
			locked = false;
			const tools = saved;
			saved = undefined;
			if (!tools) return;
			try {
				setActiveTools(tools);
			} catch {}
		},
	};
}

export interface GitFinalizeReceipt {
	kind: "git_finalize";
	version: 1;
	status: GitFinalizeResult["status"];
	commit: string;
	requestedPush: boolean;
	operationSatisfied: boolean;
	upstream?: string;
	pushError?: string;
}

export function createGitFinalizeReceipt(result: GitFinalizeResult, requestedPush: boolean): GitFinalizeReceipt {
	return {
		kind: "git_finalize",
		version: 1,
		status: result.status,
		commit: result.commit,
		requestedPush,
		operationSatisfied: result.status !== "partial" && (!requestedPush || result.status === "pushed"),
		...(result.upstream ? { upstream: result.upstream } : {}),
		...(result.pushError ? { pushError: result.pushError } : {}),
	};
}

/** The current assistant message is synchronized before tool_call handlers run. */
export function hasSiblingToolCall(entries: readonly unknown[], toolCallId: string): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const message = (entry as { message?: unknown }).message;
		if (!message || typeof message !== "object" || Array.isArray(message)) continue;
		const candidate = message as { role?: unknown; content?: unknown };
		if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) continue;
		const ids = candidate.content.flatMap((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return [];
			const call = item as { type?: unknown; id?: unknown };
			return call.type === "toolCall" && typeof call.id === "string" ? [call.id] : [];
		});
		if (!ids.includes(toolCallId)) continue;
		return ids.some((id) => id !== toolCallId);
	}
	return false;
}

interface FinalizeOptions {
	exec: GitExec;
	cwd: string;
	config: GitFinalizeConfig;
	intent?: string;
	push: boolean;
	hasUI: boolean;
	signal?: AbortSignal;
	confirm: (title: string, message: string) => Promise<boolean>;
	generateSubject: (metadata: GitMetadata, intent?: string, signal?: AbortSignal) => Promise<string>;
}

const GIT_TIMEOUT = 10_000;

async function runGit(exec: GitExec, cwd: string, args: string[], signal?: AbortSignal, timeout = GIT_TIMEOUT): Promise<GitExecResult> {
	return exec("git", ["--no-optional-locks", ...args], { cwd, timeout, signal });
}

function hashIndex(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

function sanitizeLine(value: string): string {
	return value
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/https?:\/\/[^@\s]+@/gi, "https://***@")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
}

async function stagedFingerprint(exec: GitExec, cwd: string, signal?: AbortSignal): Promise<string> {
	const raw = await runGit(exec, cwd, ["diff", "--cached", "--raw", "--full-index", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"], signal);
	if (raw.code !== 0) throw new GitFinalizeError("inspection_failed", "Could not fingerprint staged changes");
	return hashIndex(raw.stdout);
}

export async function inspectStagedGit(exec: GitExec, cwd: string, signal?: AbortSignal): Promise<GitMetadata> {
	const rootResult = await runGit(exec, cwd, ["rev-parse", "--show-toplevel"], signal);
	if (rootResult.code !== 0 || !rootResult.stdout.trim()) throw new GitFinalizeError("not_git_repo", "Current directory is not a Git repository");
	const root = rootResult.stdout.trim();
	const changed = await runGit(exec, root, ["diff", "--cached", "--quiet", "--exit-code"], signal);
	if (changed.code === 0) throw new GitFinalizeError("no_staged_changes", "No staged changes to commit");
	if (changed.code !== 1) throw new GitFinalizeError("inspection_failed", "Could not inspect staged changes");

	const [branchResult, upstreamResult, nameStatusResult, statResult, logResult, fingerprint] = await Promise.all([
		runGit(exec, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
		runGit(exec, root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], signal),
		runGit(exec, root, ["diff", "--cached", "--name-status", "--no-renames", "--no-ext-diff", "--no-textconv"], signal),
		runGit(exec, root, ["diff", "--cached", "--stat", "--no-renames", "--no-ext-diff", "--no-textconv"], signal),
		runGit(exec, root, ["log", "-10", "--pretty=format:%s"], signal),
		stagedFingerprint(exec, root, signal),
	]);
	if (nameStatusResult.code !== 0 || statResult.code !== 0) throw new GitFinalizeError("inspection_failed", "Could not read staged metadata");
	const nameStatus = nameStatusResult.stdout.slice(0, 20_000);
	const stat = statResult.stdout.slice(0, 20_000);
	return {
		root,
		...(branchResult.code === 0 && branchResult.stdout.trim() ? { branch: sanitizeLine(branchResult.stdout) } : {}),
		...(upstreamResult.code === 0 && upstreamResult.stdout.trim() ? { upstream: sanitizeLine(upstreamResult.stdout) } : {}),
		nameStatus,
		stat,
		recentSubjects: logResult.code === 0 ? logResult.stdout.split("\n").map(sanitizeLine).filter(Boolean).slice(0, 10) : [],
		fileCount: nameStatus.split("\n").filter(Boolean).length,
		fingerprint,
	};
}

export async function finalizeGit(options: FinalizeOptions): Promise<GitFinalizeResult> {
	if (!options.hasUI && !options.config.allowHeadless) throw new GitFinalizeError("headless_denied", "Git finalize is disabled without an interactive UI");
	if (options.push && !options.config.allowPush) throw new GitFinalizeError("push_disabled", "Git push is disabled by auxiliary configuration");
	const metadata = await inspectStagedGit(options.exec, options.cwd, options.signal);
	if (options.push && !metadata.branch) throw new GitFinalizeError("detached_head", "Cannot push from a detached HEAD");
	if (options.push && !metadata.upstream) throw new GitFinalizeError("no_upstream", "Push requires an existing upstream branch");

	const generated = await options.generateSubject(metadata, options.intent?.slice(0, 500), options.signal);
	const subject = validateCommitSubject(generated);
	if (!subject) throw new GitFinalizeError("invalid_subject", "Generated commit subject is invalid");
	if (options.config.confirm && options.hasUI) {
		const action = options.push ? `commit and push to ${metadata.upstream}` : "commit only";
		const confirmed = await options.confirm(
			"Finalize staged changes",
			[
				`Branch: ${metadata.branch ?? "(detached)"}`,
				`Files: ${metadata.fileCount}`,
				`Message: ${subject}`,
				`Action: ${action}`,
			].join("\n"),
		);
		if (!confirmed) throw new GitFinalizeError("cancelled", "Git finalize was cancelled");
	}

	const rechecked = await stagedFingerprint(options.exec, metadata.root, options.signal);
	if (rechecked !== metadata.fingerprint) throw new GitFinalizeError("staged_changed", "Staged changes changed while preparing the commit");
	const commit = await runGit(options.exec, metadata.root, ["commit", "-m", subject], options.signal, 120_000);
	if (commit.code !== 0) {
		const detail = sanitizeLine(commit.stderr) || sanitizeLine(commit.stdout);
		throw new GitFinalizeError("commit_failed", detail ? `Git commit failed: ${detail}` : "Git commit failed");
	}
	const hashResult = await runGit(options.exec, metadata.root, ["rev-parse", "HEAD"], options.signal);
	const hash = hashResult.code === 0 ? hashResult.stdout.trim() : "unknown";
	if (!options.push) {
		return { status: "committed", commit: hash, message: subject, branch: metadata.branch };
	}

	const pushed = await runGit(options.exec, metadata.root, ["push", "--porcelain"], options.signal, 120_000);
	if (pushed.code !== 0) {
		return {
			status: "partial",
			commit: hash,
			message: subject,
			branch: metadata.branch,
			upstream: metadata.upstream,
			pushError: sanitizeLine(pushed.stderr || pushed.stdout || "Git push failed"),
		};
	}
	return { status: "pushed", commit: hash, message: subject, branch: metadata.branch, upstream: metadata.upstream };
}
