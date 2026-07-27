import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { sha256Text, type BundleArtifactRef } from "./bundle.ts";
import type { PilotExpectedAgent } from "./delegation.ts";
import { validateVerificationCommand } from "./planning.ts";

export const PILOT_VERIFICATION_TIMEOUT_MS = 900_000;

export interface GitBaseline {
	head: string;
	indexTree: string;
	status: string;
	worktreeDiffHash: string;
	stagedDiffHash: string;
	untrackedFilesHash: string;
	digest: string;
}

export interface DelegatedProfileBinding {
	agent: string;
	agentDefinitionHash: string;
	policyDigest: string;
	allowedTools: string[];
	writeRoots: string[];
	expectedAgent: PilotExpectedAgent;
}

export interface VerificationLifecycleScript {
	name: string;
	script: string;
}

export interface VerificationScript {
	command: string;
	script: string;
	lifecycleScripts: VerificationLifecycleScript[];
}

export interface VerificationDisclosure {
	packageJsonSha256: string;
	verificationScripts: VerificationScript[];
}

export interface ExecutionEnvelope {
	version: 1;
	runId: string;
	sourceRevision: number;
	cwd: string;
	pilotActivation: "auto" | "manual";
	modePolicy: "ask" | "plan" | "edit" | "auto";
	effectiveRoute: "edit";
	topology: "primary_solo";
	isolation: "none";
	requirements: BundleArtifactRef;
	handoff: BundleArtifactRef;
	baseline: GitBaseline;
	worker: DelegatedProfileBinding;
	reviewer: DelegatedProfileBinding;
	verificationCommands: string[];
	verificationTimeoutMs: number;
	packageJsonSha256: string;
	verificationScripts: VerificationScript[];
	digest: string;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
}

export function stableJson(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertHash(value: string, label: string): void {
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeBinding(binding: DelegatedProfileBinding, role: "worker" | "reviewer", cwd: string): DelegatedProfileBinding {
	if (!binding.agent.trim()) throw new Error(`Pilot ${role} agent is required.`);
	if (!binding.expectedAgent || binding.expectedAgent.source !== "package" || !binding.expectedAgent.filePath
		|| !binding.expectedAgent.packageName || binding.expectedAgent.requireNoOverride !== true) {
		throw new Error(`Pilot ${role} profile pin is required.`);
	}
	assertHash(binding.expectedAgent.definitionHash, `Pilot ${role} expected definitionHash`);
	assertHash(binding.agentDefinitionHash, `Pilot ${role} agentDefinitionHash`);
	if (binding.expectedAgent.definitionHash !== binding.agentDefinitionHash) {
		throw new Error(`Pilot ${role} resolved profile does not match its pinned definition.`);
	}
	assertHash(binding.policyDigest, `Pilot ${role} policyDigest`);
	const allowedTools = [...new Set(binding.allowedTools)].sort();
	const writeRoots = [...new Set(binding.writeRoots.map((root) => {
		if (!path.isAbsolute(root)) throw new Error(`Pilot ${role} write roots must be absolute.`);
		const absolute = path.resolve(root);
		let canonical: string;
		try {
			canonical = realpathSync.native(absolute);
			if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new Error(`Pilot ${role} write root must be an existing directory: ${root}`);
		}
		if (canonical !== absolute) throw new Error(`Pilot ${role} write root must be canonical and contain no symlink aliases: ${root}`);
		if (!isWithin(cwd, canonical)) throw new Error(`Pilot ${role} write root is outside the delegated cwd: ${root}`);
		return canonical;
	}))].sort();
	if (allowedTools.length === 0) throw new Error(`Pilot ${role} tools are required.`);
	if (role === "worker") {
		if (!allowedTools.includes("edit") && !allowedTools.includes("write")) throw new Error("Pilot worker must have a constrained write tool.");
		if (writeRoots.length === 0) throw new Error("Pilot worker write roots are required.");
	} else if (allowedTools.includes("edit") || allowedTools.includes("write") || writeRoots.length > 0) {
		throw new Error("Pilot reviewer must be read-only.");
	}
	return { ...binding, allowedTools, writeRoots };
}

function lifecycleScripts(scripts: Record<string, unknown>, scriptName: string): VerificationLifecycleScript[] {
	return [`pre${scriptName}`, scriptName, `post${scriptName}`].flatMap((name) => {
		const script = scripts[name];
		return typeof script === "string" && script.trim() ? [{ name, script: script.trim() }] : [];
	});
}

export function resolveVerificationDisclosure(cwd: string, commands: readonly string[]): VerificationDisclosure {
	const packagePath = path.join(realpathSync.native(cwd), "package.json");
	let source: string;
	let parsed: unknown;
	try {
		source = readFileSync(packagePath, "utf8");
		parsed = JSON.parse(source);
	} catch (error) {
		throw new Error(`Pilot could not read package.json for verification disclosure: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Pilot package.json must be an object.");
	const scriptsValue = (parsed as Record<string, unknown>).scripts;
	const scripts = scriptsValue && typeof scriptsValue === "object" && !Array.isArray(scriptsValue)
		? scriptsValue as Record<string, unknown>
		: {};
	const verificationScripts = commands.map((command) => {
		const normalized = validateVerificationCommand(command);
		const [program, action, name] = normalized.split(" ");
		if (program === "bun" && action === "test") {
			return {
				command: normalized,
				script: "<bun built-in test runner>",
				lifecycleScripts: [{ name: "bun test", script: "<bun built-in test runner>" }],
			};
		}
		const scriptName = action === "test" ? "test" : name!;
		const script = scripts[scriptName];
		if (typeof script !== "string" || !script.trim()) throw new Error(`Pilot package script is missing: ${scriptName}`);
		return { command: normalized, script: script.trim(), lifecycleScripts: lifecycleScripts(scripts, scriptName) };
	});
	return { packageJsonSha256: sha256Text(source), verificationScripts };
}

export function resolveVerificationScripts(cwd: string, commands: readonly string[]): VerificationScript[] {
	return resolveVerificationDisclosure(cwd, commands).verificationScripts;
}

export function buildExecutionEnvelope(input: Omit<ExecutionEnvelope, "version" | "digest" | "worker" | "reviewer" | "verificationCommands" | "verificationTimeoutMs" | "packageJsonSha256" | "verificationScripts"> & {
	worker: DelegatedProfileBinding;
	reviewer: DelegatedProfileBinding;
	verificationCommands: string[];
}): ExecutionEnvelope {
	if (!input.runId.trim() || !Number.isInteger(input.sourceRevision) || input.sourceRevision < 0) {
		throw new Error("Pilot Envelope run identity is invalid.");
	}
	const cwd = realpathSync.native(input.cwd);
	if (!path.isAbsolute(cwd)) throw new Error("Pilot Envelope cwd must be absolute.");
	if (input.effectiveRoute !== "edit") throw new Error("Pilot Work requires an EDIT route.");
	if (input.topology !== "primary_solo" || input.isolation !== "none") throw new Error("Only primary-solo is available in this Pilot phase.");
	for (const [label, artifact] of [["requirements", input.requirements], ["handoff", input.handoff]] as const) {
		assertHash(artifact.sha256, `Pilot Envelope ${label}`);
		if (!artifact.path || artifact.bytes < 0) throw new Error(`Pilot Envelope ${label} artifact is invalid.`);
	}
	assertHash(input.baseline.digest, "Pilot Envelope baseline");
	const verificationCommands = input.verificationCommands.map(validateVerificationCommand);
	if (verificationCommands.length === 0) throw new Error("Pilot Envelope verification commands are required.");
	const disclosure = resolveVerificationDisclosure(cwd, verificationCommands);
	const unsigned = {
		version: 1 as const,
		runId: input.runId,
		sourceRevision: input.sourceRevision,
		cwd,
		pilotActivation: input.pilotActivation,
		modePolicy: input.modePolicy,
		effectiveRoute: "edit" as const,
		topology: "primary_solo" as const,
		isolation: "none" as const,
		requirements: input.requirements,
		handoff: input.handoff,
		baseline: input.baseline,
		worker: normalizeBinding(input.worker, "worker", cwd),
		reviewer: normalizeBinding(input.reviewer, "reviewer", cwd),
		verificationCommands,
		verificationTimeoutMs: PILOT_VERIFICATION_TIMEOUT_MS,
		packageJsonSha256: disclosure.packageJsonSha256,
		verificationScripts: disclosure.verificationScripts,
	};
	return { ...unsigned, digest: digest(unsigned) };
}

export function sameExecutionEnvelope(left: ExecutionEnvelope, right: ExecutionEnvelope): boolean {
	return left.digest === right.digest && stableJson({ ...left, digest: undefined }) === stableJson({ ...right, digest: undefined });
}

function gitRaw(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
		throw new Error(`Git baseline command failed (${args.join(" ")}): ${stderr || "unknown error"}`);
	}
}

function git(cwd: string, args: string[]): string {
	return gitRaw(cwd, args).trim();
}

export function resolveGitCommonDir(cwd: string): string {
	const project = realpathSync.native(cwd);
	const output = git(project, ["rev-parse", "--git-common-dir"]);
	return realpathSync.native(path.resolve(project, output));
}

function hashRegularFile(filePath: string): string {
	const hash = createHash("sha256");
	const descriptor = openSync(filePath, "r");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		let bytesRead: number;
		do {
			bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
		} while (bytesRead > 0);
	} finally {
		closeSync(descriptor);
	}
	return hash.digest("hex");
}

function hashUntrackedFiles(project: string): string {
	const files = gitRaw(project, ["ls-files", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter(Boolean)
		.sort();
	const entries = files.map((relativePath) => {
		const filePath = path.join(project, relativePath);
		const stat = lstatSync(filePath);
		const mode = stat.mode & 0o777777;
		if (stat.isSymbolicLink()) {
			return { path: relativePath, mode, type: "symlink", target: readlinkSync(filePath) };
		}
		if (!stat.isFile()) throw new Error(`Pilot cannot fingerprint unsupported untracked path type: ${relativePath}`);
		return { path: relativePath, mode, type: "file", bytes: stat.size, sha256: hashRegularFile(filePath) };
	});
	return digest(entries);
}

export function captureGitBaseline(cwd: string): GitBaseline {
	const project = realpathSync.native(cwd);
	const head = git(project, ["rev-parse", "HEAD"]);
	const indexTree = git(project, ["write-tree"]);
	const status = gitRaw(project, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	const worktreeDiffHash = sha256Text(git(project, ["diff", "--no-ext-diff", "--binary", "HEAD"]));
	const stagedDiffHash = sha256Text(git(project, ["diff", "--cached", "--no-ext-diff", "--binary"]));
	const untrackedFilesHash = hashUntrackedFiles(project);
	const unsigned = { head, indexTree, status, worktreeDiffHash, stagedDiffHash, untrackedFilesHash };
	return { ...unsigned, digest: digest(unsigned) };
}

export function assertCleanPrimarySoloBaseline(baseline: GitBaseline): void {
	if (baseline.status) throw new Error("Pilot primary-solo Phase 1 requires a clean Git worktree and index.");
}

export function commandArgs(command: string): { command: string; args: string[] } {
	const normalized = validateVerificationCommand(command);
	const [program, ...args] = normalized.split(" ");
	return { command: program!, args };
}
