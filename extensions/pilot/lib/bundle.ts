import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

export const PILOT_BUNDLE_SCHEMA_VERSION = 1 as const;

export type BundleStatus =
	| "planning"
	| "ready_for_work"
	| "working"
	| "verifying"
	| "reviewing"
	| "passed"
	| "blocked"
	| "failed"
	| "cancelled";
export type BundlePhase = "planning" | "ready" | "work" | "verify" | "review" | "terminal";
export type BundleArtifactName = "requirements" | "handoff" | "execution" | "receipt" | "implementationReview";

export interface BundleArtifactRef {
	path: string;
	sha256: string;
	bytes: number;
}

export interface BundleAuthorization {
	digest: string;
	envelope: Record<string, unknown>;
	authorizedAt: string;
}

export interface BundleActiveRequest {
	id: string;
	role: "planner" | "worker" | "reviewer";
	generation: number;
}

export interface PilotWorkPlan {
	writeRoots: string[];
	verificationCommands: string[];
	acceptance: string[];
}

export interface PilotBundleManifest {
	schemaVersion: typeof PILOT_BUNDLE_SCHEMA_VERSION;
	runId: string;
	revision: number;
	cwd: string;
	originalPrompt: string;
	modePolicy: "ask" | "plan" | "edit" | "auto";
	pilotActivation: "auto" | "manual";
	effectiveRoute: "plan" | "edit";
	status: BundleStatus;
	phase: BundlePhase;
	createdAt: string;
	updatedAt: string;
	topology: "primary_solo";
	isolation: "none";
	artifacts: Partial<Record<BundleArtifactName, BundleArtifactRef>>;
	handoffFingerprint?: string;
	workPlan?: PilotWorkPlan;
	needsDecision?: string;
	activeRequest?: BundleActiveRequest;
	authorization?: BundleAuthorization;
	terminalReason?: string;
}

export interface PilotBundle {
	dir: string;
	manifest: PilotBundleManifest;
}

const ARTIFACT_PATHS: Record<BundleArtifactName, string> = {
	requirements: "requirements.md",
	handoff: "handoff.md",
	execution: "execution.json",
	receipt: "receipt.json",
	implementationReview: "reviews/implementation-01.json",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRunId(runId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
		throw new Error("Pilot Bundle runId is invalid.");
	}
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSecureDirectory(value: string, label: string): string {
	const absolute = path.resolve(value);
	try {
		const entry = lstatSync(absolute);
		if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("not a secure directory");
		const resolved = realpathSync.native(absolute);
		if (resolved !== absolute) throw new Error("directory path contains a symlink");
		return resolved;
	} catch {
		throw new Error(`${label} must be a secure existing directory without symlinks.`);
	}
}

function ensureSecureChildDirectory(parentValue: string, name: string, label: string): string {
	const parent = assertSecureDirectory(parentValue, `${label} parent`);
	const target = path.join(parent, name);
	if (!existsSync(target)) mkdirSync(target, { mode: 0o700 });
	const resolved = assertSecureDirectory(target, label);
	if (!isWithin(parent, resolved)) throw new Error(`${label} escapes its parent directory.`);
	chmodSync(resolved, 0o700);
	return resolved;
}

function assertExistingDirectory(value: string, label: string): string {
	try {
		const resolved = realpathSync.native(value);
		if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
		return resolved;
	} catch {
		throw new Error(`${label} must be an existing directory.`);
	}
}

function assertIsoDate(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO date string.`);
	return value;
}

function assertHash(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
	return value;
}

function parseArtifactRef(value: unknown, label: string): BundleArtifactRef {
	if (!isRecord(value) || typeof value.path !== "string" || !value.path || typeof value.bytes !== "number" || !Number.isInteger(value.bytes) || value.bytes < 0) {
		throw new Error(`${label} is invalid.`);
	}
	return { path: value.path, sha256: assertHash(value.sha256, `${label}.sha256`), bytes: value.bytes };
}

function parseArtifacts(value: unknown): Partial<Record<BundleArtifactName, BundleArtifactRef>> {
	if (!isRecord(value)) throw new Error("manifest.artifacts must be an object.");
	const artifacts: Partial<Record<BundleArtifactName, BundleArtifactRef>> = {};
	for (const name of Object.keys(ARTIFACT_PATHS) as BundleArtifactName[]) {
		if (value[name] !== undefined) artifacts[name] = parseArtifactRef(value[name], `manifest.artifacts.${name}`);
	}
	for (const key of Object.keys(value)) {
		if (!(key in ARTIFACT_PATHS)) throw new Error(`Unknown Pilot Bundle artifact: ${key}.`);
	}
	return artifacts;
}

function stringList(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`${label} must be a string array.`);
	}
	return [...new Set(value.map((item) => (item as string).trim()))];
}

function parseManifest(value: unknown): PilotBundleManifest {
	if (!isRecord(value)) throw new Error("Pilot Bundle manifest must be an object.");
	if (value.schemaVersion !== PILOT_BUNDLE_SCHEMA_VERSION) throw new Error("Unsupported Pilot Bundle manifest schema.");
	if (typeof value.runId !== "string") throw new Error("Pilot Bundle manifest runId is invalid.");
	assertRunId(value.runId);
	if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) {
		throw new Error("Pilot Bundle manifest revision is invalid.");
	}
	if (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)) throw new Error("Pilot Bundle manifest cwd is invalid.");
	if (typeof value.originalPrompt !== "string" || !value.originalPrompt.trim()) throw new Error("Pilot Bundle originalPrompt is required.");
	if (value.modePolicy !== "ask" && value.modePolicy !== "plan" && value.modePolicy !== "edit" && value.modePolicy !== "auto") {
		throw new Error("Pilot Bundle modePolicy is invalid.");
	}
	if (value.pilotActivation !== "auto" && value.pilotActivation !== "manual") throw new Error("Pilot Bundle pilotActivation is invalid.");
	if (value.effectiveRoute !== "plan" && value.effectiveRoute !== "edit") throw new Error("Pilot Bundle effectiveRoute is invalid.");
	const statuses: BundleStatus[] = ["planning", "ready_for_work", "working", "verifying", "reviewing", "passed", "blocked", "failed", "cancelled"];
	const phases: BundlePhase[] = ["planning", "ready", "work", "verify", "review", "terminal"];
	if (!statuses.includes(value.status as BundleStatus) || !phases.includes(value.phase as BundlePhase)) {
		throw new Error("Pilot Bundle lifecycle state is invalid.");
	}
	if (value.topology !== "primary_solo" || value.isolation !== "none") throw new Error("Pilot Bundle topology is invalid.");
	const manifest: PilotBundleManifest = {
		schemaVersion: PILOT_BUNDLE_SCHEMA_VERSION,
		runId: value.runId,
		revision: value.revision,
		cwd: value.cwd,
		originalPrompt: value.originalPrompt,
		modePolicy: value.modePolicy,
		pilotActivation: value.pilotActivation,
		effectiveRoute: value.effectiveRoute,
		status: value.status as BundleStatus,
		phase: value.phase as BundlePhase,
		createdAt: assertIsoDate(value.createdAt, "manifest.createdAt"),
		updatedAt: assertIsoDate(value.updatedAt, "manifest.updatedAt"),
		topology: "primary_solo",
		isolation: "none",
		artifacts: parseArtifacts(value.artifacts),
	};
	if (value.handoffFingerprint !== undefined) manifest.handoffFingerprint = assertHash(value.handoffFingerprint, "manifest.handoffFingerprint");
	if (value.workPlan !== undefined) {
		if (!isRecord(value.workPlan)) throw new Error("manifest.workPlan is invalid.");
		manifest.workPlan = {
			writeRoots: stringList(value.workPlan.writeRoots, "manifest.workPlan.writeRoots"),
			verificationCommands: stringList(value.workPlan.verificationCommands, "manifest.workPlan.verificationCommands"),
			acceptance: stringList(value.workPlan.acceptance, "manifest.workPlan.acceptance"),
		};
	}
	if (value.needsDecision !== undefined) {
		if (typeof value.needsDecision !== "string" || !value.needsDecision.trim()) throw new Error("manifest.needsDecision is invalid.");
		manifest.needsDecision = value.needsDecision;
	}
	if (value.terminalReason !== undefined) {
		if (typeof value.terminalReason !== "string" || !value.terminalReason.trim()) throw new Error("manifest.terminalReason is invalid.");
		manifest.terminalReason = value.terminalReason;
	}
	if (value.activeRequest !== undefined) {
		if (!isRecord(value.activeRequest) || typeof value.activeRequest.id !== "string" || !value.activeRequest.id
			|| (value.activeRequest.role !== "planner" && value.activeRequest.role !== "worker" && value.activeRequest.role !== "reviewer")
			|| typeof value.activeRequest.generation !== "number" || !Number.isInteger(value.activeRequest.generation) || value.activeRequest.generation < 0) {
			throw new Error("manifest.activeRequest is invalid.");
		}
		manifest.activeRequest = { id: value.activeRequest.id, role: value.activeRequest.role, generation: value.activeRequest.generation };
	}
	if (value.authorization !== undefined) {
		if (!isRecord(value.authorization) || !isRecord(value.authorization.envelope)) throw new Error("manifest.authorization is invalid.");
		manifest.authorization = {
			digest: assertHash(value.authorization.digest, "manifest.authorization.digest"),
			envelope: value.authorization.envelope,
			authorizedAt: assertIsoDate(value.authorization.authorizedAt, "manifest.authorization.authorizedAt"),
		};
	}
	return manifest;
}

function manifestPath(bundleDir: string): string {
	return path.join(bundleDir, "manifest.json");
}

function assertSecureFile(filePath: string, label: string): void {
	if (!existsSync(filePath)) return;
	const entry = lstatSync(filePath);
	if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular file, not a symlink.`);
}

function resolveArtifactPath(bundleDir: string, name: BundleArtifactName, createParent = false): string {
	const relative = ARTIFACT_PATHS[name];
	const root = assertSecureDirectory(bundleDir, "Pilot Bundle directory");
	const segments = path.dirname(relative) === "." ? [] : path.dirname(relative).split(path.sep);
	let parent = root;
	for (const segment of segments) {
		const target = path.join(parent, segment);
		if (createParent) parent = ensureSecureChildDirectory(parent, segment, "Pilot Bundle artifact directory");
		else parent = assertSecureDirectory(target, "Pilot Bundle artifact directory");
	}
	const target = path.join(parent, path.basename(relative));
	if (!isWithin(root, target)) throw new Error("Pilot Bundle artifact path escapes the Bundle.");
	assertSecureFile(target, "Pilot Bundle artifact");
	return target;
}

function atomicWrite(filePath: string, content: string): void {
	const parent = assertSecureDirectory(path.dirname(filePath), "Pilot atomic-write directory");
	if (path.dirname(filePath) !== parent) throw new Error("Pilot atomic-write path contains a symlink.");
	assertSecureFile(filePath, "Pilot atomic-write target");
	const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, content, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, filePath);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try { unlinkSync(temporary); } catch {}
	}
}

function withBundleLock<T>(bundleDir: string, action: () => T): T {
	const root = assertSecureDirectory(bundleDir, "Pilot Bundle directory");
	const lockPath = path.join(root, ".bundle.lock");
	let descriptor: number | undefined;
	let acquired = false;
	try {
		descriptor = openSync(lockPath, "wx", 0o600);
		acquired = true;
		closeSync(descriptor);
		descriptor = undefined;
		return action();
	} catch (error) {
		if (!acquired && (error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Pilot Bundle is locked by another writer.");
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		if (acquired) {
			try { unlinkSync(lockPath); } catch {}
		}
	}
}

function serializeJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256Text(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function resolvePilotRunsRoot(gitCommonDir: string): string {
	const common = assertSecureDirectory(gitCommonDir, "Git common directory");
	const pilotRoot = ensureSecureChildDirectory(common, "pilot", "Pilot state directory");
	return ensureSecureChildDirectory(pilotRoot, "runs", "Pilot runs directory");
}

export function createPilotBundle(input: {
	gitCommonDir: string;
	cwd: string;
	originalPrompt: string;
	modePolicy: PilotBundleManifest["modePolicy"];
	pilotActivation: PilotBundleManifest["pilotActivation"];
	effectiveRoute: PilotBundleManifest["effectiveRoute"];
	runId?: string;
	now?: Date;
}): PilotBundle {
	const cwd = assertExistingDirectory(input.cwd, "Pilot Bundle cwd");
	if (!input.originalPrompt.trim()) throw new Error("Pilot Bundle original prompt is required.");
	const runId = input.runId ?? randomUUID();
	assertRunId(runId);
	const runsRoot = resolvePilotRunsRoot(input.gitCommonDir);
	const dir = path.join(runsRoot, runId);
	if (existsSync(dir)) throw new Error(`Pilot Bundle already exists: ${runId}`);
	mkdirSync(dir, { mode: 0o700 });
	const secureDir = assertSecureDirectory(dir, "Pilot Bundle directory");
	chmodSync(secureDir, 0o700);
	const now = (input.now ?? new Date()).toISOString();
	const manifest: PilotBundleManifest = {
		schemaVersion: PILOT_BUNDLE_SCHEMA_VERSION,
		runId,
		revision: 0,
		cwd,
		originalPrompt: input.originalPrompt,
		modePolicy: input.modePolicy,
		pilotActivation: input.pilotActivation,
		effectiveRoute: input.effectiveRoute,
		status: "planning",
		phase: "planning",
		topology: "primary_solo",
		isolation: "none",
		createdAt: now,
		updatedAt: now,
		artifacts: {},
	};
	atomicWrite(manifestPath(secureDir), serializeJson(manifest));
	return { dir: secureDir, manifest };
}

export function openPilotBundle(bundleDir: string): PilotBundle {
	const dir = assertSecureDirectory(bundleDir, "Pilot Bundle directory");
	const filePath = manifestPath(dir);
	assertSecureFile(filePath, "Pilot Bundle manifest");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new Error(`Could not load Pilot Bundle manifest: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { dir, manifest: parseManifest(raw) };
}

function preparePilotBundleUpdate(
	bundle: PilotBundle,
	mutate: (current: Readonly<PilotBundleManifest>) => Omit<PilotBundleManifest, "revision" | "updatedAt">,
	now: Date,
): { current: PilotBundle; next: PilotBundleManifest } {
	const current = openPilotBundle(bundle.dir);
	if (current.manifest.revision !== bundle.manifest.revision) {
		throw new Error("Pilot Bundle changed concurrently; reload it before updating.");
	}
	const candidate = mutate(current.manifest);
	const next = parseManifest({
		...candidate,
		revision: current.manifest.revision + 1,
		updatedAt: now.toISOString(),
	});
	if (next.runId !== current.manifest.runId || next.cwd !== current.manifest.cwd || next.createdAt !== current.manifest.createdAt) {
		throw new Error("Pilot Bundle identity is immutable.");
	}
	return { current, next };
}

export function updatePilotBundle(
	bundle: PilotBundle,
	mutate: (current: Readonly<PilotBundleManifest>) => Omit<PilotBundleManifest, "revision" | "updatedAt">,
	now = new Date(),
): PilotBundle {
	return withBundleLock(bundle.dir, () => {
		const { current, next } = preparePilotBundleUpdate(bundle, mutate, now);
		atomicWrite(manifestPath(current.dir), serializeJson(next));
		return { dir: current.dir, manifest: next };
	});
}

export function writePilotBundleArtifact(bundle: PilotBundle, name: BundleArtifactName, content: string): PilotBundle {
	return withBundleLock(bundle.dir, () => {
		const normalized = content.endsWith("\n") ? content : `${content}\n`;
		const ref: BundleArtifactRef = { path: ARTIFACT_PATHS[name], sha256: sha256Text(normalized), bytes: Buffer.byteLength(normalized) };
		const { current, next } = preparePilotBundleUpdate(bundle, (manifest) => ({
			...manifest,
			artifacts: { ...manifest.artifacts, [name]: ref },
			...(name === "handoff" ? { handoffFingerprint: ref.sha256 } : {}),
		}), new Date());
		const target = resolveArtifactPath(current.dir, name, true);
		atomicWrite(target, normalized);
		atomicWrite(manifestPath(current.dir), serializeJson(next));
		return { dir: current.dir, manifest: next };
	});
}

export function commitPilotBundleTerminal(bundle: PilotBundle, input: {
	status: Extract<BundleStatus, "passed" | "blocked" | "failed" | "cancelled">;
	reason?: string;
	receipt: string;
}): PilotBundle {
	return withBundleLock(bundle.dir, () => {
		const normalized = input.receipt.endsWith("\n") ? input.receipt : `${input.receipt}\n`;
		const ref: BundleArtifactRef = {
			path: ARTIFACT_PATHS.receipt,
			sha256: sha256Text(normalized),
			bytes: Buffer.byteLength(normalized),
		};
		const { current, next } = preparePilotBundleUpdate(bundle, (manifest) => {
			if (manifest.phase === "terminal") throw new Error("Pilot Bundle is already terminal.");
			return {
				...manifest,
				status: input.status,
				phase: "terminal",
				activeRequest: undefined,
				artifacts: { ...manifest.artifacts, receipt: ref },
				...(input.reason ? { terminalReason: input.reason } : { terminalReason: undefined }),
			};
		}, new Date());
		const target = resolveArtifactPath(current.dir, "receipt", true);
		atomicWrite(target, normalized);
		atomicWrite(manifestPath(current.dir), serializeJson(next));
		return { dir: current.dir, manifest: next };
	});
}

export function readPilotBundleArtifact(bundle: PilotBundle, name: BundleArtifactName): string {
	const ref = bundle.manifest.artifacts[name];
	if (!ref) throw new Error(`Pilot Bundle artifact is missing: ${name}`);
	const filePath = resolveArtifactPath(bundle.dir, name);
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch (error) {
		throw new Error(`Could not read Pilot Bundle artifact ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (Buffer.byteLength(content) !== ref.bytes || sha256Text(content) !== ref.sha256) {
		throw new Error(`Pilot Bundle artifact integrity check failed: ${name}`);
	}
	return content;
}

export function markPilotBundleReady(bundle: PilotBundle): PilotBundle {
	readPilotBundleArtifact(bundle, "requirements");
	readPilotBundleArtifact(bundle, "handoff");
	if (bundle.manifest.needsDecision) throw new Error("Pilot Bundle has an unresolved decision.");
	return updatePilotBundle(bundle, (current) => ({
		...current,
		status: "ready_for_work",
		phase: "ready",
		activeRequest: undefined,
	}));
}
