import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { FileArtifact, PresentationArtifactState } from "./types.ts";

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_DIFF_CELLS = 1_000_000;
export const MAX_PERSISTED_ARTIFACTS = 100;
export const MAX_PERSISTED_ARTIFACT_BYTES = 64 * 1024;
const NON_MUTATING_TOOL_NAMES = new Set([
	"read", "grep", "find", "ls",
	"web_search", "fetch_content", "get_search_content", "web_research",
	"aux_summarize", "process_update", "question", "questionnaire",
	"intercom", "subagent_supervisor", "subagent_wait",
]);
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;

type ToolResultLike = { content?: unknown; details?: unknown };
type ToolResultRef = { toolCallId?: unknown; toolName?: unknown };

export interface SafeArtifactPath {
	path: string;
	insideWorkspace: boolean;
	absolutePath?: string;
}

interface ResolvedArtifactPath extends SafeArtifactPath {
	identity: string;
}

export interface GitFileState {
	path: string;
	operation: FileArtifact["operation"];
	fingerprint?: string;
	additions?: number;
	deletions?: number;
	/** True only when Git reports a content diff, not a mode/index-only record. */
	contentChanged?: boolean;
	/** Retained when a base-to-worktree diff replaces status-relative tracked entries. */
	untracked?: boolean;
}

export interface GitSnapshot {
	files: Map<string, GitFileState>;
	head?: string;
	headChanges?: Map<string, GitFileState>;
}

export type GitRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

type FileKind = "absent" | "file" | "symlink" | "other";

interface FileSnapshot {
	kind: FileKind;
	fingerprint?: string;
	text?: string;
}

interface PendingWrite {
	toolName: "edit" | "write";
	path: ResolvedArtifactPath;
	inputFingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolveExistingPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		let ancestor = dirname(path);
		const tail: string[] = [basename(path)];
		while (ancestor !== dirname(ancestor) && !existsSync(ancestor)) {
			tail.unshift(basename(ancestor));
			ancestor = dirname(ancestor);
		}
		try {
			return join(realpathSync(ancestor), ...tail);
		} catch {
			return path;
		}
	}
}

export function sanitizeArtifactLabel(value: unknown, fallback = "file"): string {
	if (typeof value !== "string") return fallback;
	const clean = stripVTControlCharacters(value)
		.replace(CONTROL_CHARACTERS, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
	return clean || fallback;
}

function resolveArtifactPath(rawPath: unknown, cwd: string): ResolvedArtifactPath {
	if (typeof rawPath !== "string" || !rawPath.trim()) return { path: "file", identity: "", insideWorkspace: false };
	const root = resolveExistingPath(resolve(cwd));
	const requested = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
	const target = resolveExistingPath(requested);
	if (!isInside(root, target)) {
		return { path: sanitizeArtifactLabel(basename(target) || basename(requested)), identity: "", insideWorkspace: false };
	}
	const workspacePath = isInside(root, requested) ? requested : target;
	const identity = relative(root, workspacePath) || basename(target) || "file";
	return {
		path: sanitizeArtifactLabel(identity),
		identity,
		insideWorkspace: true,
		absolutePath: workspacePath,
	};
}

export function sanitizeArtifactPath(rawPath: unknown, cwd: string): SafeArtifactPath {
	const { identity: _identity, ...safe } = resolveArtifactPath(rawPath, cwd);
	return safe;
}

/** Git paths name index entries, so preserve a final symlink instead of following its target. */
function resolveGitArtifactPath(rawPath: string, cwd: string, repositoryRoot: string): ResolvedArtifactPath {
	const workspaceRoot = resolveExistingPath(resolve(cwd));
	const repositoryPath = resolve(resolveExistingPath(resolve(repositoryRoot)), rawPath);
	const absolutePath = join(resolveExistingPath(dirname(repositoryPath)), basename(repositoryPath));
	if (!isInside(workspaceRoot, absolutePath)) {
		return { path: sanitizeArtifactLabel(basename(absolutePath)), identity: "", insideWorkspace: false };
	}
	const identity = relative(workspaceRoot, absolutePath) || basename(absolutePath) || "file";
	return {
		path: sanitizeArtifactLabel(identity),
		identity,
		insideWorkspace: true,
		absolutePath,
	};
}

function splitLines(value: string): string[] {
	if (!value) return [];
	const lines = value.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export function diffLineStats(before: string, after: string): { additions: number; deletions: number } | undefined {
	const oldLines = splitLines(before);
	const newLines = splitLines(after);
	if (oldLines.length * newLines.length > MAX_DIFF_CELLS) return undefined;
	let previous = new Uint32Array(newLines.length + 1);
	for (const oldLine of oldLines) {
		const current = new Uint32Array(newLines.length + 1);
		for (let index = 1; index <= newLines.length; index += 1) {
			current[index] = oldLine === newLines[index - 1]
				? previous[index - 1]! + 1
				: Math.max(previous[index]!, current[index - 1]!);
		}
		previous = current;
	}
	const common = previous[newLines.length]!;
	return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function snapshotPath(path: string): FileSnapshot {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			const target = readlinkSync(path);
			return { kind: "symlink", fingerprint: createHash("sha256").update(target).digest("hex") };
		}
		if (!stat.isFile()) return { kind: "other" };
		const content = readFileSync(path);
		const fingerprint = createHash("sha256").update(content).digest("hex");
		if (content.length > MAX_TEXT_BYTES || content.includes(0)) return { kind: "file", fingerprint };
		return { kind: "file", fingerprint, text: content.toString("utf8") };
	} catch {
		return { kind: "absent" };
	}
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
	return left.kind === right.kind && left.fingerprint === right.fingerprint;
}

function operationForStatus(status: string): FileArtifact["operation"] {
	if (status.includes("D")) return "deleted";
	if (status.includes("A") || status === "?") return "added";
	return "modified";
}

function parseNumstat(output: string): Map<string, { additions?: number; deletions?: number }> {
	const stats = new Map<string, { additions?: number; deletions?: number }>();
	const records = output.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[index] ?? "");
		if (!match) continue;
		let path = match[3] ?? "";
		if (!path) {
			index += 1; // old rename/copy path
			path = records[++index] ?? "";
		}
		if (!path) continue;
		const additions = match[1] === "-" ? undefined : Number(match[1]);
		const deletions = match[2] === "-" ? undefined : Number(match[2]);
		stats.set(path, { ...(additions !== undefined ? { additions } : {}), ...(deletions !== undefined ? { deletions } : {}) });
	}
	return stats;
}

function hasContentDiff(stat: { additions?: number; deletions?: number } | undefined): boolean {
	return stat !== undefined && (
		stat.additions === undefined
		|| stat.deletions === undefined
		|| stat.additions > 0
		|| stat.deletions > 0
	);
}

function parseNameStatus(
	output: string,
	cwd: string,
	repositoryRoot: string,
	stats: Map<string, { additions?: number; deletions?: number }>,
): Map<string, GitFileState> {
	const files = new Map<string, GitFileState>();
	const parts = output.split("\0").filter(Boolean);
	for (let index = 0; index < parts.length;) {
		const status = parts[index++]!;
		const rawPath = parts[index++];
		if (!rawPath) break;
		const pairedPath = /^[RC]/.test(status) ? parts[index++] : undefined;
		if (status.startsWith("R")) {
			const source = resolveGitArtifactPath(rawPath, cwd, repositoryRoot);
			if (source.insideWorkspace) files.set(source.identity, { path: source.path, operation: "deleted" });
		} else if (!status.startsWith("C")) {
			const safe = resolveGitArtifactPath(rawPath, cwd, repositoryRoot);
			if (safe.insideWorkspace) {
				const stat = stats.get(rawPath) ?? stats.get(safe.identity);
				files.set(safe.identity, {
					path: safe.path,
					operation: operationForStatus(status),
					...(stat ?? {}),
					...(hasContentDiff(stat) ? { contentChanged: true } : {}),
				});
			}
		}
		if (pairedPath) {
			const target = resolveGitArtifactPath(pairedPath, cwd, repositoryRoot);
			if (target.insideWorkspace) {
				const stat = stats.get(pairedPath) ?? stats.get(target.identity);
				files.set(target.identity, {
					path: target.path,
					operation: "added",
					...(hasContentDiff(stat) ? { ...stat, contentChanged: true } : {}),
				});
			}
		}
	}
	return files;
}

async function parseGitStatus(
	output: string,
	cwd: string,
	repositoryRoot: string,
	numstat: Map<string, { additions?: number; deletions?: number }>,
): Promise<GitSnapshot> {
	const files = new Map<string, GitFileState>();
	const records = output.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index]!;
		if (!record) continue;
		let status = "";
		let rawPath = "";
		if (record.startsWith("? ")) {
			status = "?";
			rawPath = record.slice(2);
		} else if (record.startsWith("1 ")) {
			const parts = record.split(" ");
			status = parts[1] ?? "";
			rawPath = parts.slice(8).join(" ");
		} else if (record.startsWith("2 ")) {
			const parts = record.split(" ");
			status = parts[1] ?? "";
			rawPath = parts.slice(9).join(" ");
			const originalPath = records[++index] ?? "";
			const target = resolveGitArtifactPath(rawPath, cwd, repositoryRoot);
			if (target.insideWorkspace) {
				const stat = numstat.get(rawPath) ?? numstat.get(target.identity);
				files.set(target.identity, {
					path: target.path,
					operation: "added",
					...(hasContentDiff(stat) ? { ...stat, contentChanged: true } : {}),
				});
			}
			if (status.includes("R")) {
				const original = resolveGitArtifactPath(originalPath, cwd, repositoryRoot);
				if (original.insideWorkspace) files.set(original.identity, { path: original.path, operation: "deleted" });
			}
			continue;
		} else if (record.startsWith("u ")) {
			const parts = record.split(" ");
			status = parts[1] ?? "";
			rawPath = parts.slice(10).join(" ");
		} else {
			continue;
		}
		const safe = resolveGitArtifactPath(rawPath, cwd, repositoryRoot);
		if (!safe.insideWorkspace || !safe.absolutePath) continue;
		const current = snapshotPath(safe.absolutePath);
		const stat = numstat.get(rawPath) ?? numstat.get(safe.identity);
		const operation = record.startsWith("u ")
			? current.kind === "absent" ? "deleted" : status.includes("A") ? "added" : "modified"
			: operationForStatus(status);
		files.set(safe.identity, {
			path: safe.path,
			operation,
			...(current.fingerprint ? { fingerprint: current.fingerprint } : {}),
			...(stat ?? {}),
			...(hasContentDiff(stat) ? { contentChanged: true } : {}),
			...(status === "?" ? { untracked: true } : {}),
		});
	}
	return { files };
}

export async function captureGitSnapshot(runGit: GitRunner, cwd: string, baseHead?: string): Promise<GitSnapshot | undefined> {
	try {
		const status = await runGit(["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		if (status.code !== 0) return undefined;
		const [head, root] = await Promise.all([
			runGit(["rev-parse", "HEAD"]),
			runGit(["rev-parse", "--show-toplevel"]),
		]);
		const headRef = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : undefined;
		const repositoryRoot = root.code === 0 && root.stdout.trim() ? resolve(root.stdout.trim()) : resolve(cwd);
		// Comparing the worktree to HEAD includes both staged and unstaged content,
		// while a mode-only index change remains a 0/0 numstat record.
		const numstat = await runGit(headRef
			? ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", headRef]
			: ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"]);
		const snapshot = await parseGitStatus(status.stdout, cwd, repositoryRoot, numstat.code === 0 ? parseNumstat(numstat.stdout) : new Map());
		if (headRef) snapshot.head = headRef;
		if (baseHead && snapshot.head && snapshot.head !== baseHead) {
			const [names, stats] = await Promise.all([
				runGit(["diff", "--name-status", "-z", "--no-ext-diff", "--no-textconv", baseHead]),
				runGit(["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", baseHead]),
			]);
			if (names.code === 0) {
				const netChanges = parseNameStatus(names.stdout, cwd, repositoryRoot, stats.code === 0 ? parseNumstat(stats.stdout) : new Map());
				const untracked = [...snapshot.files].filter(([, state]) => state.untracked);
				snapshot.files = new Map([...netChanges, ...untracked]);
				snapshot.headChanges = netChanges;
			}
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

/**
 * Legacy helper retained for callers outside the request journal. A path that
 * merely disappears from Git status is not treated as a filesystem mutation.
 */
export function reconcileGitSnapshots(
	before: GitSnapshot,
	after: GitSnapshot,
	excludedPaths: ReadonlySet<string>,
	initialDirtyPaths: ReadonlySet<string> = new Set(before.files.keys()),
): FileArtifact[] {
	const artifacts: FileArtifact[] = [];
	for (const [path, current] of after.files) {
		if (excludedPaths.has(path)) continue;
		const previous = before.files.get(path);
		if (previous && previous.operation === current.operation && previous.fingerprint === current.fingerprint) continue;
		artifacts.push({
			path: current.path,
			operation: current.operation,
			...(initialDirtyPaths.has(path) ? { preExisting: true } : {}),
			...(previous ? {} : current.additions !== undefined ? { additions: current.additions } : {}),
			...(previous ? {} : current.deletions !== undefined ? { deletions: current.deletions } : {}),
			sources: ["git"],
		});
	}
	return artifacts;
}

function inputForTool(args: unknown, cwd: string): { path: ResolvedArtifactPath; fingerprint: string } {
	const record = isRecord(args) ? args : {};
	const path = resolveArtifactPath(record.path, cwd);
	return { path, fingerprint: JSON.stringify({ path: record.path, content: record.content, edits: record.edits }) };
}

function addSource(sources: Map<string, Set<string>>, identity: string, source: string): void {
	if (!identity) return;
	const values = sources.get(identity) ?? new Set<string>();
	values.add(source);
	sources.set(identity, values);
}

function artifactFromSnapshots(
	path: string,
	before: FileSnapshot,
	after: FileSnapshot,
	sources: string[],
	preExisting: boolean,
): FileArtifact | undefined {
	if (sameSnapshot(before, after)) return undefined;
	let operation: FileArtifact["operation"];
	if (before.kind === "absent" && after.kind !== "absent") operation = "added";
	else if (before.kind !== "absent" && after.kind === "absent") operation = "deleted";
	else operation = "modified";
	const stats = before.text !== undefined && after.text !== undefined
		? diffLineStats(before.text, after.text)
		: before.text === undefined && after.text !== undefined && before.kind === "absent"
			? diffLineStats("", after.text)
			: undefined;
	return {
		path,
		operation,
		...(stats?.additions !== undefined ? { additions: stats.additions } : {}),
		...(stats?.deletions !== undefined ? { deletions: stats.deletions } : {}),
		sources,
		...(preExisting ? { preExisting: true } : {}),
	};
}

function artifactFromGit(state: GitFileState, sources: string[], preExisting: boolean): FileArtifact {
	return {
		path: state.path,
		operation: state.operation,
		...(state.additions !== undefined ? { additions: state.additions } : {}),
		...(state.deletions !== undefined ? { deletions: state.deletions } : {}),
		sources,
		...(preExisting ? { preExisting: true } : {}),
	};
}

function artifactDigest(files: FileArtifact[], gitReconciled: boolean, fingerprints: string[]): string {
	return JSON.stringify({ files, gitReconciled, fingerprints });
}

function sortArtifacts(files: FileArtifact[]): FileArtifact[] {
	return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

export class ArtifactJournal {
	private cwd = process.cwd();
	private requestId = "request";
	private startedAt = Date.now();
	private baseGit: GitSnapshot | undefined;
	private readonly baselines = new Map<string, FileSnapshot>();
	private readonly initialDirty = new Set<string>();
	private readonly sources = new Map<string, Set<string>>();
	private readonly pending = new Map<string, PendingWrite>();
	private readonly successful = new Set<string>();
	private readonly failed = new Set<string>();
	private lastRelevantToolCallId: string | undefined;
	private revision = 0;
	private previousDigest: string | undefined;
	private previousReceiptId: string | undefined;
	private hadVisibleFiles = false;

	async begin(cwd: string, baseline?: GitSnapshot, requestId = "request"): Promise<void> {
		this.cwd = cwd;
		this.requestId = requestId;
		this.startedAt = Date.now();
		this.baseGit = baseline;
		this.baselines.clear();
		this.initialDirty.clear();
		this.sources.clear();
		this.pending.clear();
		this.successful.clear();
		this.failed.clear();
		this.lastRelevantToolCallId = undefined;
		this.revision = 0;
		this.previousDigest = undefined;
		this.previousReceiptId = undefined;
		this.hadVisibleFiles = false;
		for (const [identity, state] of baseline?.files ?? []) {
			this.initialDirty.add(identity);
			this.baselines.set(identity, snapshotPath(resolve(cwd, identity)));
			addSource(this.sources, identity, "git");
			void state;
		}
	}

	baseHead(): string | undefined {
		return this.baseGit?.head;
	}

	async startTool(toolCallId: string, toolName: string, args: unknown): Promise<void> {
		if (toolName === "bash") this.lastRelevantToolCallId = toolCallId;
		if (toolName !== "edit" && toolName !== "write") return;
		const input = inputForTool(args, this.cwd);
		if (!input.path.insideWorkspace || !input.path.identity || !input.path.absolutePath) return;
		if (!this.baselines.has(input.path.identity)) this.baselines.set(input.path.identity, snapshotPath(input.path.absolutePath));
		addSource(this.sources, input.path.identity, toolName);
		this.pending.set(toolCallId, { toolName, path: input.path, inputFingerprint: input.fingerprint });
		this.lastRelevantToolCallId = toolCallId;
	}

	confirmTool(toolCallId: string, toolName: string, args: unknown): void {
		const pending = this.pending.get(toolCallId);
		if (!pending || pending.toolName !== toolName) return;
		const input = inputForTool(args, this.cwd);
		if (pending.inputFingerprint !== input.fingerprint) this.pending.delete(toolCallId);
	}

	endTool(toolCallId: string, toolName: string, _result: ToolResultLike, isError: boolean): void {
		const pending = this.pending.get(toolCallId);
		if (!pending || pending.toolName !== toolName) return;
		this.lastRelevantToolCallId = toolCallId;
		if (isError) this.failed.add(toolCallId);
		else this.successful.add(toolCallId);
	}

	async snapshot(
		turnIndex: number,
		toolResults: readonly ToolResultRef[],
		currentGit?: GitSnapshot,
	): Promise<PresentationArtifactState | undefined> {
		const gitReconciled = this.baseGit !== undefined && currentGit !== undefined;
		const gitCandidates = new Map<string, GitFileState>();
		for (const source of [this.baseGit?.files, currentGit?.files, currentGit?.headChanges]) {
			for (const [identity, state] of source ?? []) {
				gitCandidates.set(identity, state);
				addSource(this.sources, identity, "git");
			}
		}
		const files: FileArtifact[] = [];
		const fingerprints: string[] = [];
		const changedIdentities = new Set<string>();
		for (const [identity, sourceSet] of this.sources) {
			const gitState = gitCandidates.get(identity);
			const path = gitState?.path ?? sanitizeArtifactLabel(identity);
			const after = snapshotPath(resolve(this.cwd, identity));
			const before = this.baselines.get(identity);
			const sources = [...sourceSet];
			const preExisting = this.initialDirty.has(identity);
			const exact = before ? artifactFromSnapshots(path, before, after, sources, preExisting) : undefined;
			if (exact) {
				files.push(exact);
				changedIdentities.add(identity);
				fingerprints.push(`${identity}\0${after.kind}\0${after.fingerprint ?? ""}`);
			} else if (!before && gitState && (gitState.operation !== "modified" || gitState.contentChanged)) {
				files.push(artifactFromGit(gitState, sources, preExisting));
				changedIdentities.add(identity);
				fingerprints.push(`${identity}\0${after.kind}\0${after.fingerprint ?? ""}`);
			}
		}
		const ordered = sortArtifacts(files);
		const digest = artifactDigest(ordered, gitReconciled, fingerprints.sort());
		const reversedResults = [...toolResults].reverse();
		const explicitAnchor = reversedResults.find((result) => {
			if (typeof result.toolCallId !== "string" || (result.toolName !== "edit" && result.toolName !== "write")) return false;
			const pending = this.pending.get(result.toolCallId);
			return this.successful.has(result.toolCallId)
				&& Boolean(pending && (ordered.length === 0 || changedIdentities.has(pending.path.identity)));
		})?.toolCallId;
		const bashAnchor = reversedResults.find((result) =>
			result.toolName === "bash" && typeof result.toolCallId === "string",
		)?.toolCallId;
		const fallbackAnchor = reversedResults.find((result) =>
			result.toolName !== "process_update"
			&& typeof result.toolName === "string"
			&& !NON_MUTATING_TOOL_NAMES.has(result.toolName)
			&& typeof result.toolCallId === "string",
		)?.toolCallId;
		const anchor = typeof explicitAnchor === "string"
			? explicitAnchor
			: typeof bashAnchor === "string"
				? bashAnchor
				: typeof fallbackAnchor === "string"
					? fallbackAnchor
					: toolResults.length === 0 ? this.lastRelevantToolCallId : undefined;
		if (!anchor) return undefined;
		if (digest === this.previousDigest) return undefined;
		if (ordered.length === 0 && !this.hadVisibleFiles) return undefined;
		const totalFiles = ordered.length;
		const totalAdditions = ordered.reduce((total, file) => total + (file.additions ?? 0), 0);
		const totalDeletions = ordered.reduce((total, file) => total + (file.deletions ?? 0), 0);
		const persistedFiles = ordered.slice(0, MAX_PERSISTED_ARTIFACTS);
		const receipt: PresentationArtifactState = {
			version: 2,
			receiptId: randomUUID(),
			requestId: this.requestId,
			revision: ++this.revision,
			...(this.previousReceiptId ? { supersedes: this.previousReceiptId } : {}),
			anchorToolCallId: anchor,
			files: persistedFiles,
			...(persistedFiles.length < totalFiles ? {
				totalFiles,
				omittedFiles: totalFiles - persistedFiles.length,
				totalAdditions,
				totalDeletions,
				truncated: true as const,
			} : {}),
			successfulWrites: this.successful.size,
			failedWrites: this.failed.size,
			gitReconciled,
			...(ordered.length === 0 ? { reverted: true as const } : {}),
			startedAt: this.startedAt,
			revisedAt: Date.now(),
		};
		while (receipt.files.length > 1 && Buffer.byteLength(JSON.stringify(receipt), "utf8") > MAX_PERSISTED_ARTIFACT_BYTES) {
			receipt.files.pop();
			receipt.totalFiles = totalFiles;
			receipt.omittedFiles = totalFiles - receipt.files.length;
			receipt.totalAdditions = totalAdditions;
			receipt.totalDeletions = totalDeletions;
			receipt.truncated = true;
		}
		this.previousDigest = digest;
		this.previousReceiptId = receipt.receiptId;
		this.hadVisibleFiles = ordered.length > 0;
		return receipt;
	}
}
