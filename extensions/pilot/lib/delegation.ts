import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import {
	createPilotWorkerCapability,
	createPilotWorkerPolicyHeader,
	discardPilotWorkerCapability,
	pilotPolicyDigest,
	type PilotPolicyCore,
	type PilotPolicyExpectedAgent,
} from "./worker-policy.ts";

export const PILOT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const PILOT_DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const PILOT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
export const PILOT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PILOT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

export interface PilotDelegationEventBus {
	on(event: string, handler: (value: unknown) => void): (() => void) | void;
	emit(event: string, value: unknown): void;
}

export interface PilotExpectedAgent {
	filePath: string;
	definitionHash: string;
	source: "package";
	packageName: string;
	requireNoOverride?: boolean;
}

export interface PilotResolvedLaunchPolicy extends PilotPolicyCore {
	digest: string;
	launchId: string;
	expiresAt: number;
}

export interface PilotDelegationResponse {
	version: 1;
	requestId: string;
	status: "completed" | "failed" | "timed_out" | "cancelled" | "interrupted" | "turn_budget_exhausted" | "tool_budget_exhausted" | "acceptance_failed" | "invalid_request" | "unavailable_context";
	error?: string;
	runId?: string;
	agent?: string;
	output?: string;
	model?: string;
	durationMs?: number;
	toolCount?: number;
}

export interface PilotDelegationUpdate {
	version: 1;
	requestId: string;
	currentTool?: string;
	recentOutput?: string;
	toolCount?: number;
	durationMs?: number;
}

export interface ConstrainedDelegationRequest {
	agent: string;
	task: string;
	cwd: string;
	allowedTools: string[];
	writeRoots: string[];
	expectedAgent?: PilotExpectedAgent;
	model?: string;
	timeoutMs?: number;
	turnBudget?: { maxTurns: number; graceTurns?: number };
	toolBudget?: { soft?: number; hard: number; block?: string[] | "*" };
	artifacts?: boolean;
}

interface PublicV1Request {
	version: 1;
	requestId: string;
	agent: string;
	task: string;
	context: "fresh";
	cwd: string;
	model?: string;
	timeoutMs?: number;
	turnBudget?: { maxTurns: number; graceTurns?: number };
	toolBudget?: { soft?: number; hard: number; block?: string[] | "*" };
	output: false;
	outputMode: "inline";
	acceptance: false;
	artifacts: boolean;
}

const ROLE_TOOLS: Record<string, string[]> = {
	"pilot.planner": ["find", "grep", "ls", "read"],
	"pilot.worker": ["edit", "find", "grep", "ls", "read", "write"],
	"pilot.reviewer": ["find", "grep", "ls", "read"],
};
const POLICY_TTL_MS = 60_000;
const grants = new Map<string, PilotResolvedLaunchPolicy>();

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalDirectory(value: string, label: string): string {
	try {
		const resolved = realpathSync.native(value);
		if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
		return resolved;
	} catch {
		throw new Error(`${label} must be an existing directory.`);
	}
}

function frontmatterFields(filePath: string): Map<string, string> | undefined {
	if (path.basename(filePath) === "SKILL.md") return undefined;
	let source: string;
	try {
		source = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
	} catch {
		return undefined;
	}
	if (!source.startsWith("---\n")) return undefined;
	const end = source.indexOf("\n---", 4);
	if (end === -1) return undefined;
	const fields = new Map<string, string>();
	for (const line of source.slice(4, end).split("\n")) {
		const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/);
		if (!match) continue;
		fields.set(match[1]!, match[2]!.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2"));
	}
	return fields;
}

function frontmatterRuntimeName(filePath: string): string | undefined {
	const fields = frontmatterFields(filePath);
	if (!fields) return undefined;
	const name = fields.get("name");
	if (!name || !fields.get("description")) return undefined;
	const packageName = fields.get("package");
	return packageName ? `${packageName}.${name}` : name;
}

function frontmatterList(value: string | undefined): string[] {
	return value === undefined ? [] : value.split("\n").flatMap((line) => line.split(",")).map((item) => item.trim()).filter(Boolean);
}

function assertPinnedPackageProfile(filePath: string, runtimeName: string): void {
	const fields = frontmatterFields(filePath);
	if (!fields || frontmatterRuntimeName(filePath) !== runtimeName) {
		throw new Error("Pilot pinned package agent frontmatter does not match its runtime identity.");
	}
	const expectedTools = runtimeName === "pilot.worker"
		? ["edit", "find", "grep", "ls", "read", "write"]
		: ["find", "grep", "ls", "read"];
	if (!sameStrings(frontmatterList(fields.get("tools")), expectedTools)
		|| fields.get("systemPromptMode") !== "replace"
		|| fields.get("inheritProjectContext") !== "false"
		|| fields.get("inheritSkills") !== "false"
		|| fields.get("defaultContext") !== "fresh"
		|| ["extensions", "subagentOnlyExtensions", "skill", "skills", "skillPath"].some((field) => fields.has(field))) {
		throw new Error("Pilot pinned package agent violates the fixed fresh profile tool registry contract.");
	}
}

function findAgentShadow(directory: string, runtimeName: string, expectedFile: string, sourceUsesSymlink?: boolean): string | undefined {
	let entries;
	try {
		const lexicalDirectory = path.resolve(directory);
		sourceUsesSymlink ??= realpathSync.native(lexicalDirectory) !== lexicalDirectory;
		entries = readdirSync(lexicalDirectory, { withFileTypes: true });
		directory = lexicalDirectory;
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		const candidate = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = findAgentShadow(candidate, runtimeName, expectedFile, sourceUsesSymlink);
			if (nested) return nested;
			continue;
		}
		if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
		let canonical: string;
		try { canonical = realpathSync.native(candidate); } catch { continue; }
		if (frontmatterRuntimeName(canonical) === runtimeName && (sourceUsesSymlink || entry.isSymbolicLink() || canonical !== expectedFile)) return candidate;
	}
	return undefined;
}

function isSafePackagePath(value: string): boolean {
	return value.length > 0 && !path.isAbsolute(value)
		&& value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseNpmPackageName(spec: string): string | undefined {
	const source = spec.slice(4).trim();
	if (!source) return undefined;
	const match = source.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	const packageName = match?.[1] ?? source;
	return isSafePackagePath(packageName) ? packageName : undefined;
}

function stripGitRef(repoPath: string): string {
	const atIndex = repoPath.indexOf("@");
	const hashIndex = repoPath.indexOf("#");
	const refIndex = [atIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
	return refIndex === undefined ? repoPath : repoPath.slice(0, refIndex);
}

function parseGitPackagePath(spec: string): { host: string; repoPath: string } | undefined {
	const trimmed = spec.trim();
	const source = /^(?:https?|ssh|git):\/\//i.test(trimmed)
		? trimmed
		: trimmed.startsWith("git:")
			? trimmed.slice(4).trim()
			: "";
	if (!source) return undefined;
	let host = "";
	let repoPath = "";
	const scpLike = source.match(/^git@([^:]+):(.+)$/);
	if (scpLike) {
		host = scpLike[1] ?? "";
		repoPath = scpLike[2] ?? "";
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
		try {
			const url = new URL(source);
			host = url.hostname;
			repoPath = url.pathname.replace(/^\/+/, "");
		} catch {
			return undefined;
		}
	} else {
		const slashIndex = source.indexOf("/");
		if (slashIndex < 0) return undefined;
		host = source.slice(0, slashIndex);
		repoPath = source.slice(slashIndex + 1);
	}
	const normalizedPath = stripGitRef(repoPath).replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !isSafePackagePath(host) || !isSafePackagePath(normalizedPath) || normalizedPath.split(/[\\/]/).length < 2) return undefined;
	return { host, repoPath: normalizedPath };
}

function settingsPackageRoot(spec: string, baseDir: string): string | undefined {
	const trimmed = spec.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("npm:")) {
		const packageName = parseNpmPackageName(trimmed);
		return packageName ? path.join(baseDir, "npm", "node_modules", packageName) : undefined;
	}
	const parsedGit = parseGitPackagePath(trimmed);
	if (parsedGit) return path.join(baseDir, "git", parsedGit.host, parsedGit.repoPath);
	if (trimmed.startsWith("git:") || /^(?:https?|ssh):\/\//i.test(trimmed)) return undefined;
	const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/")) return path.join(homedir(), normalized.slice(2));
	if (path.isAbsolute(normalized)) return normalized;
	if (normalized === "." || normalized === ".." || normalized.startsWith("./") || normalized.startsWith("../")) {
		return path.resolve(baseDir, normalized);
	}
	return undefined;
}

function agentDirectoriesFromPackageRoot(root: string): string[] {
	let manifest: unknown;
	try { manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")); } catch { return []; }
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
	const record = manifest as { "pi-subagents"?: { agents?: unknown }; pi?: { subagents?: { agents?: unknown } } };
	const entries = [record["pi-subagents"]?.agents, record.pi?.subagents?.agents];
	return entries.flatMap((agents) => Array.isArray(agents)
		? agents.flatMap((relative) => typeof relative === "string" ? [path.resolve(root, relative)] : [])
		: []);
}

function nodeModulePackageRoots(nodeModules: string): string[] {
	let entries;
	try { entries = readdirSync(nodeModules, { withFileTypes: true }); } catch { return []; }
	const roots: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
		if (!entry.name.startsWith("@")) {
			roots.push(path.join(nodeModules, entry.name));
			continue;
		}
		let scoped;
		try { scoped = readdirSync(path.join(nodeModules, entry.name), { withFileTypes: true }); } catch { continue; }
		for (const child of scoped) {
			if (!child.name.startsWith(".") && (child.isDirectory() || child.isSymbolicLink())) roots.push(path.join(nodeModules, entry.name, child.name));
		}
	}
	return roots;
}

function packageAgentDirectories(settingsPath: string): string[] {
	let settings: unknown;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch {
		return [];
	}
	const packages = settings && typeof settings === "object" && !Array.isArray(settings)
		? (settings as { packages?: unknown }).packages
		: undefined;
	if (!Array.isArray(packages)) return [];
	const directories: string[] = [];
	for (const entry of packages) {
		const spec = typeof entry === "string"
			? entry
			: entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { source?: unknown }).source === "string"
				? (entry as { source: string }).source
				: undefined;
		if (!spec) continue;
		const root = settingsPackageRoot(spec, path.dirname(settingsPath));
		if (root) directories.push(...agentDirectoriesFromPackageRoot(root));
	}
	return directories;
}

let cachedGlobalNpmRoot: string | undefined;

function globalNpmRoot(): string | undefined {
	if (cachedGlobalNpmRoot !== undefined) return cachedGlobalNpmRoot || undefined;
	try {
		cachedGlobalNpmRoot = realpathSync.native(execFileSync("npm", ["root", "-g"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim());
	} catch {
		cachedGlobalNpmRoot = "";
	}
	return cachedGlobalNpmRoot || undefined;
}

function assertNoAgentOverride(settingsPath: string, runtimeName: string): void {
	let settings: unknown;
	try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { return; }
	const overrides = settings && typeof settings === "object" && !Array.isArray(settings)
		? (settings as { subagents?: { agentOverrides?: unknown } }).subagents?.agentOverrides
		: undefined;
	if (overrides && typeof overrides === "object" && !Array.isArray(overrides) && Object.hasOwn(overrides, runtimeName)) {
		throw new Error(`Pilot pinned agent profile has an override in ${settingsPath}.`);
	}
}

function nearestSubagentProjectRoot(cwd: string): string | undefined {
	let current = cwd;
	while (true) {
		for (const marker of [path.join(current, ".pi"), path.join(current, ".agents")]) {
			try {
				if (statSync(marker).isDirectory()) return current;
			} catch {}
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function assertNoAgentShadow(cwd: string, runtimeName: string, expectedFile: string): void {
	const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = configuredAgentDir === "~"
		? homedir()
		: configuredAgentDir?.startsWith("~/")
			? path.join(homedir(), configuredAgentDir.slice(2))
			: configuredAgentDir || path.join(homedir(), ".pi", "agent");
	const projectRoot = nearestSubagentProjectRoot(cwd) ?? cwd;
	const extra = (process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS ?? "").split(path.delimiter).filter(Boolean);
	const userSettingsPath = path.join(agentDir, "settings.json");
	const projectSettingsPath = path.join(projectRoot, ".pi", "settings.json");
	assertNoAgentOverride(userSettingsPath, runtimeName);
	assertNoAgentOverride(projectSettingsPath, runtimeName);
	const packageRoots = [
		projectRoot,
		...nodeModulePackageRoots(path.join(agentDir, "npm", "node_modules")),
		...nodeModulePackageRoots(path.join(projectRoot, ".pi", "npm", "node_modules")),
		...(globalNpmRoot() ? nodeModulePackageRoots(globalNpmRoot()!) : []),
	];
	const directories = [
		...extra,
		path.join(agentDir, "agents"),
		path.join(homedir(), ".agents"),
		path.join(projectRoot, ".agents"),
		path.join(projectRoot, ".pi", "agents"),
		...packageAgentDirectories(userSettingsPath),
		...packageAgentDirectories(projectSettingsPath),
		...packageRoots.flatMap(agentDirectoriesFromPackageRoot),
	];
	for (const directory of directories) {
		const shadow = findAgentShadow(directory, runtimeName, expectedFile);
		if (shadow) throw new Error(`Pilot pinned agent profile is shadowed by ${shadow}.`);
	}
}

function resolvePolicyCore(request: ConstrainedDelegationRequest): PilotPolicyCore {
	if (!request.task.trim()) throw new Error("Pilot constrained delegation task is required.");
	const expectedTools = ROLE_TOOLS[request.agent];
	if (!expectedTools || !sameStrings(request.allowedTools, expectedTools)) {
		throw new Error(`Pilot ${request.agent} tools do not match the fixed role contract.`);
	}
	const expected = request.expectedAgent;
	if (!expected || expected.source !== "package" || expected.packageName !== "pilot" || expected.requireNoOverride !== true
		|| !/^[a-f0-9]{64}$/.test(expected.definitionHash)) {
		throw new Error("Pilot delegation requires a pinned package agent profile.");
	}
	let agentFile: string;
	try {
		agentFile = realpathSync.native(expected.filePath);
	} catch {
		throw new Error("Pilot pinned agent profile is unavailable.");
	}
	if (agentFile !== expected.filePath || sha256(readFileSync(agentFile, "utf8")) !== expected.definitionHash) {
		throw new Error("Pilot pinned agent definition changed.");
	}
	assertPinnedPackageProfile(agentFile, request.agent);
	const cwd = canonicalDirectory(request.cwd, "Pilot delegated cwd");
	assertNoAgentShadow(cwd, request.agent, agentFile);
	const writeRoots = request.writeRoots.map((root) => {
		if (path.isAbsolute(root)) throw new Error("Pilot write roots must be relative to the delegated cwd.");
		const normalized = path.normalize(root);
		if (!normalized || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
			throw new Error("Pilot write root escapes the delegated cwd.");
		}
		const resolved = canonicalDirectory(path.resolve(cwd, normalized), `Pilot write root '${root}'`);
		if (!isWithin(cwd, resolved)) throw new Error(`Pilot write root '${root}' escapes the delegated cwd.`);
		const relative = path.relative(cwd, resolved);
		if (relative === ".git" || relative.startsWith(`.git${path.sep}`)) throw new Error("Pilot write roots may not target Git metadata.");
		return resolved;
	});
	if (request.agent === "pilot.worker" ? writeRoots.length === 0 : writeRoots.length > 0) {
		throw new Error(request.agent === "pilot.worker" ? "Pilot Worker write roots are required." : "Pilot read-only roles cannot have write roots.");
	}
	return {
		version: 1,
		agent: request.agent,
		agentDefinitionHash: expected.definitionHash,
		cwd,
		allowedTools: sorted(request.allowedTools),
		writeRoots: sorted(writeRoots),
		expectedAgent: {
			filePath: agentFile,
			definitionHash: expected.definitionHash,
			source: "package",
			packageName: "pilot",
			requireNoOverride: true,
		},
		...(request.agent === "pilot.worker" ? { taskSha256: sha256(request.task) } : {}),
	};
}

function samePolicy(left: PilotResolvedLaunchPolicy, right: PilotResolvedLaunchPolicy): boolean {
	return left.launchId === right.launchId && left.expiresAt === right.expiresAt && left.digest === right.digest
		&& pilotPolicyDigest(left) === pilotPolicyDigest(right);
}

function requestId(value?: string): string {
	const next = value ?? randomUUID();
	if (!next.trim()) throw new Error("Pilot delegation requestId is required.");
	return next;
}

function createPublicRequest(input: ConstrainedDelegationRequest, id: string, task: string): PublicV1Request {
	return {
		version: 1,
		requestId: id,
		agent: input.agent,
		task,
		context: "fresh",
		cwd: realpathSync.native(input.cwd),
		...(input.model ? { model: input.model } : {}),
		...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
		...(input.turnBudget ? { turnBudget: input.turnBudget } : {}),
		...(input.toolBudget ? { toolBudget: input.toolBudget } : {}),
		output: false,
		outputMode: "inline",
		acceptance: false,
		artifacts: input.artifacts ?? false,
	};
}

function isEnvelope(value: unknown, id: string): value is { version: 1; requestId: string } {
	return !!value && typeof value === "object" && !Array.isArray(value)
		&& (value as { version?: unknown }).version === 1
		&& (value as { requestId?: unknown }).requestId === id;
}

export function requestPilotDelegation(options: {
	events: PilotDelegationEventBus;
	request: PublicV1Request;
	signal?: AbortSignal;
	availabilityTimeoutMs?: number;
	onUpdate?: (update: PilotDelegationUpdate) => void;
}): Promise<PilotDelegationResponse> {
	if (options.signal?.aborted) return Promise.reject(new Error("Pilot delegation cancelled before launch."));
	return new Promise((resolve, reject) => {
		let settled = false;
		let started = false;
		let cancelling = false;
		let completionTimer: ReturnType<typeof setTimeout> | undefined;
		const unsubscribes: Array<() => void> = [];
		const availabilityTimer = setTimeout(() => finish(() => reject(new Error(cancelling
			? "Pilot delegation cancelled before the child started."
			: "Pilot delegation is unavailable (is pi-subagents loaded?)"))), options.availabilityTimeoutMs ?? 2_000);
		const subscribe = (event: string, handler: (value: unknown) => void): void => {
			const unsubscribe = options.events.on(event, handler);
			if (typeof unsubscribe === "function") unsubscribes.push(unsubscribe);
		};
		const cleanup = (): void => {
			clearTimeout(availabilityTimer);
			if (completionTimer) clearTimeout(completionTimer);
			options.signal?.removeEventListener("abort", onAbort);
			for (const unsubscribe of unsubscribes) unsubscribe();
		};
		function finish(action: () => void): void {
			if (settled) return;
			settled = true;
			cleanup();
			action();
		}
		const onAbort = (): void => {
			if (settled || cancelling) return;
			cancelling = true;
			if (completionTimer) clearTimeout(completionTimer);
			options.events.emit(PILOT_DELEGATION_CANCEL_EVENT, { version: 1, requestId: options.request.requestId });
		};
		subscribe(PILOT_DELEGATION_STARTED_EVENT, (value) => {
			if (!isEnvelope(value, options.request.requestId)) return;
			started = true;
			clearTimeout(availabilityTimer);
			if (!cancelling) completionTimer = setTimeout(onAbort, (options.request.timeoutMs ?? 900_000) + 5_000);
		});
		subscribe(PILOT_DELEGATION_UPDATE_EVENT, (value) => {
			if (!cancelling && isEnvelope(value, options.request.requestId)) options.onUpdate?.(value as PilotDelegationUpdate);
		});
		subscribe(PILOT_DELEGATION_RESPONSE_EVENT, (value) => {
			if (isEnvelope(value, options.request.requestId)) finish(() => resolve(value as PilotDelegationResponse));
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		options.events.emit(PILOT_DELEGATION_REQUEST_EVENT, options.request);
		if (options.signal?.aborted && !started) onAbort();
	});
}

export async function preflightPilotDelegation(options: {
	events: PilotDelegationEventBus;
	request: ConstrainedDelegationRequest;
	requestId?: string;
	signal?: AbortSignal;
}): Promise<PilotResolvedLaunchPolicy> {
	if (options.signal?.aborted) throw new Error("Pilot delegation cancelled before policy preflight.");
	const core = resolvePolicyCore(options.request);
	const policy: PilotResolvedLaunchPolicy = {
		...core,
		digest: pilotPolicyDigest(core),
		launchId: randomUUID(),
		expiresAt: Date.now() + POLICY_TTL_MS,
	};
	grants.set(policy.launchId, policy);
	return policy;
}

export async function launchPilotDelegation(options: {
	events: PilotDelegationEventBus;
	request: ConstrainedDelegationRequest;
	policy: PilotResolvedLaunchPolicy;
	requestId?: string;
	signal?: AbortSignal;
	onUpdate?: (update: PilotDelegationUpdate) => void;
}): Promise<PilotDelegationResponse> {
	if (options.signal?.aborted) throw new Error("Pilot delegation cancelled before launch.");
	const granted = grants.get(options.policy.launchId);
	grants.delete(options.policy.launchId);
	if (!granted || !samePolicy(granted, options.policy)) throw new Error("Pilot delegation policy grant is not available or was already consumed.");
	if (granted.expiresAt <= Date.now()) throw new Error("Pilot delegation policy grant expired.");
	const current = resolvePolicyCore(options.request);
	if (pilotPolicyDigest(current) !== granted.digest) throw new Error("Pilot delegation policy drifted before launch.");
	const runtimePolicy = options.request.agent === "pilot.worker" ? createPilotWorkerCapability(granted) : undefined;
	const task = runtimePolicy
		? `${createPilotWorkerPolicyHeader(runtimePolicy)}\n${options.request.task}`
		: options.request.task;
	const id = requestId(options.requestId);
	let response: PilotDelegationResponse;
	try {
		response = await requestPilotDelegation({
			events: options.events,
			request: createPublicRequest(options.request, id, task),
			...(options.signal ? { signal: options.signal } : {}),
			...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
		});
	} finally {
		if (runtimePolicy) discardPilotWorkerCapability(runtimePolicy);
	}
	if (response.status === "completed" && response.agent !== options.request.agent) {
		throw new Error("Pilot delegated runtime resolved an unexpected agent profile.");
	}
	return response;
}

export function discardPilotDelegationPolicy(options: {
	events: PilotDelegationEventBus;
	requestId: string;
	policy: PilotResolvedLaunchPolicy;
}): void {
	grants.delete(options.policy.launchId);
}

export async function delegatePilotConstrained(options: {
	events: PilotDelegationEventBus;
	request: ConstrainedDelegationRequest;
	signal?: AbortSignal;
	preflightRequestId?: string;
	launchRequestId?: string;
	onUpdate?: (update: PilotDelegationUpdate) => void;
}): Promise<{ policy: PilotResolvedLaunchPolicy; response: PilotDelegationResponse }> {
	const policy = await preflightPilotDelegation(options);
	const response = await launchPilotDelegation({
		events: options.events,
		request: options.request,
		policy,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.launchRequestId ? { requestId: options.launchRequestId } : {}),
		...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
	});
	return { policy, response };
}
