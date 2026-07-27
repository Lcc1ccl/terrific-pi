import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const PILOT_WORKER_POLICY_PREFIX = "PILOT_WORKER_POLICY_V1 ";
export const PILOT_WORKER_BOOTSTRAP_TOOLS = ["find", "grep", "ls", "read"] as const;

export interface PilotPolicyExpectedAgent {
	filePath: string;
	definitionHash: string;
	source: "package";
	packageName: string;
	requireNoOverride: true;
}

export interface PilotPolicyCore {
	version: 1;
	agent: string;
	agentDefinitionHash: string;
	cwd: string;
	allowedTools: string[];
	writeRoots: string[];
	expectedAgent: PilotPolicyExpectedAgent;
	taskSha256?: string;
}

export interface PilotWorkerRuntimePolicy extends PilotPolicyCore {
	digest: string;
	launchId: string;
	expiresAt: number;
	capabilityPath: string;
	capabilitySha256: string;
}

export type PilotWorkerPolicyParseResult =
	| { ok: true; policy: PilotWorkerRuntimePolicy }
	| { ok: false; error: string };

export interface PilotWorkerGuardResult {
	block: true;
	reason: string;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isGitMetadataPath(cwd: string, candidate: string): boolean {
	const relative = path.relative(cwd, candidate);
	return relative === ".git" || relative.startsWith(`.git${path.sep}`);
}

function canonicalWriteTarget(value: string): string {
	let cursor = value;
	const suffix: string[] = [];
	while (true) {
		try {
			return path.resolve(realpathSync.native(cursor), ...suffix);
		} catch {
			const parent = path.dirname(cursor);
			if (parent === cursor) throw new Error(`Could not resolve write path: ${value}`);
			suffix.unshift(path.basename(cursor));
			cursor = parent;
		}
	}
}

function canonicalCore(value: PilotPolicyCore): PilotPolicyCore {
	return {
		version: 1,
		agent: value.agent,
		agentDefinitionHash: value.agentDefinitionHash,
		cwd: value.cwd,
		allowedTools: sorted(value.allowedTools),
		writeRoots: sorted(value.writeRoots),
		expectedAgent: {
			filePath: value.expectedAgent.filePath,
			definitionHash: value.expectedAgent.definitionHash,
			source: "package",
			packageName: value.expectedAgent.packageName,
			requireNoOverride: true,
		},
		...(value.taskSha256 ? { taskSha256: value.taskSha256 } : {}),
	};
}

export function pilotPolicyDigest(value: PilotPolicyCore): string {
	return sha256(JSON.stringify(canonicalCore(value)));
}

let capabilityRoot: string | undefined;

function getCapabilityRoot(): string {
	if (!capabilityRoot) {
		capabilityRoot = mkdtempSync(path.join(tmpdir(), "pilot-worker-grants-"));
		chmodSync(capabilityRoot, 0o700);
	}
	return capabilityRoot;
}

function capabilityContent(policy: PilotPolicyCore & { digest: string; launchId: string }, nonce: string): string {
	return `${JSON.stringify({
		version: 1,
		launchId: policy.launchId,
		digest: policy.digest,
		taskSha256: policy.taskSha256,
		nonce,
	})}\n`;
}

export function createPilotWorkerCapability(policy: PilotPolicyCore & {
	digest: string;
	launchId: string;
	expiresAt: number;
}): PilotWorkerRuntimePolicy {
	if (policy.agent !== "pilot.worker" || !isHash(policy.taskSha256) || pilotPolicyDigest(policy) !== policy.digest) {
		throw new Error("Pilot Worker policy cannot create a runtime capability.");
	}
	const content = capabilityContent(policy, randomUUID());
	const capabilityPath = path.join(getCapabilityRoot(), `${policy.launchId}-${randomUUID()}.json`);
	writeFileSync(capabilityPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return { ...policy, capabilityPath, capabilitySha256: sha256(content) };
}

export function discardPilotWorkerCapability(policy: Pick<PilotWorkerRuntimePolicy, "capabilityPath">): void {
	rmSync(policy.capabilityPath, { force: true });
}

export function createPilotWorkerPolicyHeader(policy: PilotWorkerRuntimePolicy): string {
	if (policy.agent !== "pilot.worker" || !isHash(policy.taskSha256) || pilotPolicyDigest(policy) !== policy.digest
		|| !path.isAbsolute(policy.capabilityPath) || !isHash(policy.capabilitySha256)) {
		throw new Error("Pilot Worker policy is invalid.");
	}
	return `${PILOT_WORKER_POLICY_PREFIX}${Buffer.from(JSON.stringify({
		...canonicalCore(policy),
		digest: policy.digest,
		launchId: policy.launchId,
		expiresAt: policy.expiresAt,
		capabilityPath: policy.capabilityPath,
		capabilitySha256: policy.capabilitySha256,
	})).toString("base64url")}`;
}

function parsePolicy(value: unknown): PilotWorkerRuntimePolicy {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("policy payload must be an object");
	const record = value as Record<string, unknown>;
	const supported = new Set(["version", "agent", "agentDefinitionHash", "cwd", "allowedTools", "writeRoots", "expectedAgent", "taskSha256", "digest", "launchId", "expiresAt", "capabilityPath", "capabilitySha256"]);
	if (Object.keys(record).some((key) => !supported.has(key))) throw new Error("policy payload has unsupported fields");
	if (record.version !== 1 || record.agent !== "pilot.worker" || !isHash(record.agentDefinitionHash)
		|| typeof record.cwd !== "string" || !path.isAbsolute(record.cwd)
		|| !Array.isArray(record.allowedTools) || record.allowedTools.some((tool) => typeof tool !== "string" || !tool)
		|| !Array.isArray(record.writeRoots) || record.writeRoots.length === 0 || record.writeRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root))
		|| !isHash(record.taskSha256) || !isHash(record.digest)
		|| typeof record.launchId !== "string" || !/^[a-f0-9-]{36}$/.test(record.launchId)
		|| typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)
		|| typeof record.capabilityPath !== "string" || !path.isAbsolute(record.capabilityPath)
		|| !isHash(record.capabilitySha256)) {
		throw new Error("policy payload has invalid required fields");
	}
	if (!record.expectedAgent || typeof record.expectedAgent !== "object" || Array.isArray(record.expectedAgent)) {
		throw new Error("policy payload has no pinned agent");
	}
	const expected = record.expectedAgent as Record<string, unknown>;
	if (Object.keys(expected).some((key) => !["filePath", "definitionHash", "source", "packageName", "requireNoOverride"].includes(key))
		|| typeof expected.filePath !== "string" || !path.isAbsolute(expected.filePath)
		|| !isHash(expected.definitionHash) || expected.source !== "package"
		|| expected.packageName !== "pilot" || expected.requireNoOverride !== true
		|| record.agentDefinitionHash !== expected.definitionHash) {
		throw new Error("policy payload pinned agent is invalid");
	}
	return {
		version: 1,
		agent: "pilot.worker",
		agentDefinitionHash: record.agentDefinitionHash,
		cwd: record.cwd,
		allowedTools: sorted(record.allowedTools as string[]),
		writeRoots: sorted(record.writeRoots as string[]),
		expectedAgent: {
			filePath: expected.filePath,
			definitionHash: expected.definitionHash,
			source: "package",
			packageName: "pilot",
			requireNoOverride: true,
		},
		taskSha256: record.taskSha256,
		digest: record.digest,
		launchId: record.launchId,
		expiresAt: record.expiresAt,
		capabilityPath: record.capabilityPath,
		capabilitySha256: record.capabilitySha256,
	};
}

function extractPolicyLineAndTask(prompt: string): { policyLine: string; task: string } {
	const firstBreak = prompt.indexOf("\n");
	const firstLine = firstBreak === -1 ? prompt : prompt.slice(0, firstBreak);
	if (firstLine.startsWith(PILOT_WORKER_POLICY_PREFIX)) {
		return { policyLine: firstLine, task: firstBreak === -1 ? "" : prompt.slice(firstBreak + 1) };
	}
	if (firstLine.startsWith(`Task: ${PILOT_WORKER_POLICY_PREFIX}`)) {
		return { policyLine: firstLine.slice("Task: ".length), task: firstBreak === -1 ? "" : prompt.slice(firstBreak + 1) };
	}
	if (!/^<file name="[^"\r\n]*[\\/]task\.md">$/.test(firstLine) || firstBreak === -1) {
		throw new Error("Worker task has no Pilot runtime policy");
	}
	const secondBreak = prompt.indexOf("\n", firstBreak + 1);
	if (secondBreak === -1) throw new Error("Worker task file has no policy line");
	const secondLine = prompt.slice(firstBreak + 1, secondBreak);
	if (!secondLine.startsWith(`Task: ${PILOT_WORKER_POLICY_PREFIX}`)) throw new Error("Worker task file has no Pilot runtime policy");
	const suffix = "\n</file>\n";
	if (!prompt.endsWith(suffix)) throw new Error("Worker task file wrapper is malformed");
	return {
		policyLine: secondLine.slice("Task: ".length),
		task: prompt.slice(secondBreak + 1, -suffix.length),
	};
}

function consumeWorkerCapability(policy: PilotWorkerRuntimePolicy): void {
	const parent = path.dirname(policy.capabilityPath);
	const parentEntry = lstatSync(parent);
	if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory() || (parentEntry.mode & 0o077) !== 0
		|| !path.basename(parent).startsWith("pilot-worker-grants-") || realpathSync.native(parent) !== parent) {
		throw new Error("Worker capability directory is not private and canonical");
	}
	const entry = lstatSync(policy.capabilityPath);
	if (entry.isSymbolicLink() || !entry.isFile() || (entry.mode & 0o077) !== 0) {
		throw new Error("Worker capability is not a private regular file");
	}
	if (typeof process.getuid === "function" && (entry.uid !== process.getuid() || parentEntry.uid !== process.getuid())) {
		throw new Error("Worker capability has the wrong owner");
	}
	const consumedPath = `${policy.capabilityPath}.consumed-${process.pid}-${randomUUID()}`;
	renameSync(policy.capabilityPath, consumedPath);
	try {
		const consumed = lstatSync(consumedPath);
		if (consumed.isSymbolicLink() || !consumed.isFile()) throw new Error("Worker capability changed during consumption");
		const content = readFileSync(consumedPath, "utf8");
		if (sha256(content) !== policy.capabilitySha256) throw new Error("Worker capability content hash mismatch");
		const value = JSON.parse(content) as Record<string, unknown>;
		if (Object.keys(value).some((key) => !["version", "launchId", "digest", "taskSha256", "nonce"].includes(key))
			|| value.version !== 1 || value.launchId !== policy.launchId || value.digest !== policy.digest
			|| value.taskSha256 !== policy.taskSha256 || typeof value.nonce !== "string"
			|| !/^[a-f0-9-]{36}$/.test(value.nonce)) {
			throw new Error("Worker capability does not match the launch policy");
		}
	} finally {
		rmSync(consumedPath, { force: true });
	}
}

export function parsePilotWorkerPolicyPrompt(input: {
	prompt: string;
	cwd: string;
	activeTools: readonly string[];
	childAgent: string | undefined;
	now?: number;
}): PilotWorkerPolicyParseResult {
	try {
		if (input.childAgent !== "pilot.worker") throw new Error("child agent identity does not match pilot.worker");
		const extracted = extractPolicyLineAndTask(input.prompt);
		const encoded = extracted.policyLine.slice(PILOT_WORKER_POLICY_PREFIX.length);
		if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Worker policy encoding is invalid");
		const policy = parsePolicy(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
		if (policy.expiresAt <= (input.now ?? Date.now())) throw new Error("Worker policy has expired");
		const cwd = realpathSync.native(input.cwd);
		if (cwd !== policy.cwd) throw new Error("Worker policy cwd does not match the child cwd");
		if (!sameStrings(input.activeTools, PILOT_WORKER_BOOTSTRAP_TOOLS)) throw new Error("Worker bootstrap tools do not match the read-only package profile");
		if (!sameStrings(policy.allowedTools, [...PILOT_WORKER_BOOTSTRAP_TOOLS, "edit", "write"])) throw new Error("Worker authorized tools are invalid");
		if (sha256(extracted.task) !== policy.taskSha256) throw new Error("Worker task does not match the authorized policy");
		if (pilotPolicyDigest(policy) !== policy.digest) throw new Error("Worker policy digest mismatch");
		const agentFile = realpathSync.native(policy.expectedAgent.filePath);
		if (agentFile !== policy.expectedAgent.filePath
			|| sha256(readFileSync(agentFile, "utf8")) !== policy.agentDefinitionHash) {
			throw new Error("Worker pinned agent definition changed");
		}
		for (const root of policy.writeRoots) {
			const canonical = realpathSync.native(root);
			if (canonical !== root || !statSync(canonical).isDirectory() || !isWithin(cwd, canonical) || isGitMetadataPath(cwd, canonical)) {
				throw new Error("Worker write root is not canonical and inside cwd");
			}
		}
		consumeWorkerCapability(policy);
		return { ok: true, policy };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function guardPilotWorkerToolCall(
	policy: PilotWorkerRuntimePolicy | undefined,
	failure: string | undefined,
	toolName: string,
	input: unknown,
): PilotWorkerGuardResult | undefined {
	if (!policy || failure) return { block: true, reason: `Pilot Worker runtime policy is unavailable: ${failure ?? "missing policy"}` };
	if (!policy.allowedTools.includes(toolName)) return { block: true, reason: `Tool '${toolName}' is not allowed by the Pilot Worker policy.` };
	if (toolName !== "edit" && toolName !== "write") return;
	const writable = input && typeof input === "object" && !Array.isArray(input) ? input as { path?: unknown } : undefined;
	if (typeof writable?.path !== "string" || !writable.path.trim()) {
		return { block: true, reason: `Tool '${toolName}' is missing a valid path.` };
	}
	try {
		const requested = writable.path.startsWith("@") ? writable.path.slice(1) : writable.path;
		const lexical = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(policy.cwd, requested);
		if (isGitMetadataPath(policy.cwd, lexical)) throw new Error("Write path targets protected Git metadata.");
		const target = canonicalWriteTarget(lexical);
		if (!policy.writeRoots.some((root) => isWithin(root, target))) {
			throw new Error(`Write path is outside the authorized roots: ${writable.path}`);
		}
		writable.path = target;
		return;
	} catch (error) {
		return { block: true, reason: error instanceof Error ? error.message : String(error) };
	}
}
