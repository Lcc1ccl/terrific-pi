import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
	persistPilotReceipt,
	receiptFromTerminal,
} from "./receipt.ts";
import {
	updatePilotBundle,
	writePilotBundleArtifact,
	type BundleStatus,
	type PilotBundle,
} from "./bundle.ts";
import {
	captureGitBaseline,
	PILOT_VERIFICATION_TIMEOUT_MS,
	resolveVerificationDisclosure,
	stableJson,
	type DelegatedProfileBinding,
	type ExecutionEnvelope,
	type GitBaseline,
} from "./envelope.ts";
import type {
	ConstrainedDelegationRequest,
	PilotDelegationResponse,
	PilotResolvedLaunchPolicy,
} from "./delegation.ts";
import {
	assertPilotAcceptanceEvidence,
	parsePilotReviewResult,
	parsePilotWorkerReport,
	type PilotReviewResult,
	type PilotWorkerReport,
	type VerificationEvidence,
	runPilotVerification,
} from "./review.ts";

export interface PrimarySoloDelegator {
	preflight(request: ConstrainedDelegationRequest, requestId: string, signal?: AbortSignal): Promise<PilotResolvedLaunchPolicy>;
	launch(request: ConstrainedDelegationRequest, policy: PilotResolvedLaunchPolicy, requestId: string, signal?: AbortSignal): Promise<PilotDelegationResponse>;
}

export interface PrimarySoloDependencies extends PrimarySoloDelegator {
	captureBaseline?: (cwd: string) => GitBaseline;
	changedFiles?: (cwd: string) => string[];
	indexClean?: (cwd: string) => boolean;
	verify?: (command: string, cwd: string, signal?: AbortSignal) => Promise<VerificationEvidence>;
	now?: () => Date;
}

export interface PrimarySoloRunResult {
	bundle: PilotBundle;
	status: Extract<BundleStatus, "passed" | "blocked" | "failed" | "cancelled">;
	changedFiles: string[];
	verification: VerificationEvidence[];
	worker?: PilotWorkerReport;
	reviewer?: PilotReviewResult;
	reason?: string;
}

class PrimarySoloError extends Error {
	readonly status: Extract<BundleStatus, "blocked" | "failed" | "cancelled">;

	constructor(message: string, status: Extract<BundleStatus, "blocked" | "failed" | "cancelled"> = "blocked") {
		super(message);
		this.name = "PrimarySoloError";
		this.status = status;
	}
}

function gitRaw(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
		throw new Error(`Git command failed (${args.join(" ")}): ${stderr || "unknown error"}`);
	}
}

function git(cwd: string, args: string[]): string {
	return gitRaw(cwd, args).trim();
}

function nulPaths(value: string): string[] {
	return value.split("\0").filter(Boolean);
}

export function listPrimarySoloChangedFiles(cwd: string): string[] {
	const tracked = nulPaths(gitRaw(cwd, ["diff", "--no-ext-diff", "--name-only", "-z", "HEAD"]));
	const untracked = nulPaths(gitRaw(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
	return [...new Set([...tracked, ...untracked])].sort();
}

function gitDiff(cwd: string, args: string[], allowDifferenceExit = false): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 }).trim();
	} catch (error) {
		const result = error as { status?: number; stdout?: unknown; stderr?: unknown };
		if (allowDifferenceExit && result.status === 1) return String(result.stdout ?? "").trim();
		const stderr = String(result.stderr ?? "").trim();
		throw new Error(`Git diff command failed (${args.join(" ")}): ${stderr || "unknown error"}`);
	}
}

export function capturePrimarySoloDiff(cwd: string, changedFiles: readonly string[], maximumBytes = 256 * 1024): string {
	const files = sorted(changedFiles);
	if (files.length === 0) throw new PrimarySoloError("Pilot cannot review an empty project delta.");
	const untracked = new Set(nulPaths(gitRaw(cwd, ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", ...files])));
	const tracked = files.filter((file) => !untracked.has(file));
	const parts: string[] = [];
	if (tracked.length > 0) parts.push(gitDiff(cwd, ["--literal-pathspecs", "diff", "--no-ext-diff", "--binary", "HEAD", "--", ...tracked]));
	for (const file of files.filter((candidate) => untracked.has(candidate))) {
		parts.push(gitDiff(cwd, ["--literal-pathspecs", "diff", "--no-ext-diff", "--binary", "--no-index", "--", "/dev/null", file], true));
	}
	const diff = parts.filter(Boolean).join("\n");
	if (!diff) throw new PrimarySoloError("Pilot could not capture the authorized Git diff for review.");
	if (Buffer.byteLength(diff) > maximumBytes) throw new PrimarySoloError("Pilot review diff exceeds the 256 KiB evidence limit.");
	return diff;
}

export function isPrimarySoloIndexClean(cwd: string): boolean {
	return git(cwd, ["diff", "--cached", "--name-only"]).length === 0;
}

function sorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function equalLists(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function assertPolicyMatchesBinding(policy: PilotResolvedLaunchPolicy, binding: DelegatedProfileBinding, cwd: string): void {
	if (policy.agent !== binding.agent || policy.agentDefinitionHash !== binding.agentDefinitionHash || policy.digest !== binding.policyDigest || policy.cwd !== cwd
		|| !equalLists(policy.allowedTools, binding.allowedTools) || !equalLists(policy.writeRoots, binding.writeRoots)) {
		throw new PrimarySoloError("Pilot delegation policy drifted after Work Gate authorization.");
	}
}

function relativeWriteRoots(cwd: string, roots: readonly string[]): string[] {
	return roots.map((root) => {
		const relative = path.relative(cwd, root);
		if (relative === "") return ".";
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new PrimarySoloError("Authorized worker write root escapes the delegated cwd.");
		}
		return relative.split(path.sep).join("/");
	});
}

export function assertChangedFilesInScope(cwd: string, changedFiles: readonly string[], writeRoots: readonly string[]): void {
	for (const changed of changedFiles) {
		const candidate = path.resolve(cwd, changed);
		const allowed = writeRoots.some((root) => {
			const relative = path.relative(root, candidate);
			return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
		});
		if (!allowed) throw new PrimarySoloError(`Observed changed file is outside the authorized write scope: ${changed}`);
	}
}

function assertObservedMatchesWorker(worker: PilotWorkerReport, changedFiles: readonly string[]): void {
	if (changedFiles.length === 0) throw new PrimarySoloError("Pilot worker completed without an observed project change.", "failed");
	if (!equalLists(worker.changedFiles, changedFiles)) {
		throw new PrimarySoloError("Pilot worker declared changed files do not match the observed Git delta.");
	}
}

function assertVerificationDisclosureUnchanged(envelope: ExecutionEnvelope): void {
	const current = resolveVerificationDisclosure(envelope.cwd, envelope.verificationCommands);
	if (current.packageJsonSha256 !== envelope.packageJsonSha256
		|| stableJson(current.verificationScripts) !== stableJson(envelope.verificationScripts)) {
		throw new PrimarySoloError("Pilot package.json verification disclosure changed after Work authorization.");
	}
}

function makeRequest(binding: DelegatedProfileBinding, cwd: string, task: string): ConstrainedDelegationRequest {
	return {
		agent: binding.agent,
		task,
		cwd,
		allowedTools: binding.allowedTools,
		writeRoots: relativeWriteRoots(cwd, binding.writeRoots),
		expectedAgent: binding.expectedAgent,
		timeoutMs: 900_000,
		artifacts: false,
	};
}

function requireCompleted(response: PilotDelegationResponse, role: "worker" | "reviewer"): string {
	if (response.status === "cancelled" || response.status === "interrupted") {
		throw new PrimarySoloError(`Pilot ${role} was cancelled.`, "cancelled");
	}
	if (response.status !== "completed" || !response.output?.trim()) {
		throw new PrimarySoloError(`Pilot ${role} failed: ${response.error ?? response.status}`, "failed");
	}
	return response.output;
}

function requireNotCancelled(signal: AbortSignal | undefined, phase: string): void {
	if (signal?.aborted) throw new PrimarySoloError(`Pilot work was cancelled during ${phase}.`, "cancelled");
}

function transition(bundle: PilotBundle, status: BundleStatus, phase: "work" | "verify" | "review" | "terminal", activeRequest?: PilotBundle["manifest"]["activeRequest"], reason?: string): PilotBundle {
	return updatePilotBundle(bundle, (current) => ({
		...current,
		status,
		phase,
		...(activeRequest ? { activeRequest } : { activeRequest: undefined }),
		...(reason ? { terminalReason: reason } : {}),
	}));
}

function persistTerminal(options: {
	bundle: PilotBundle;
	envelope: ExecutionEnvelope;
	status: Extract<BundleStatus, "blocked" | "failed" | "cancelled">;
	before: GitBaseline;
	after?: GitBaseline;
	changedFiles: string[];
	worker?: { requestId: string; runId?: string; report?: PilotWorkerReport };
	reviewer?: { requestId: string; runId?: string; result?: PilotReviewResult };
	verification: VerificationEvidence[];
	reason: string;
	residualRisks: string[];
}): PrimarySoloRunResult {
	const receipt = receiptFromTerminal({
		bundle: options.bundle,
		envelope: options.envelope,
		status: options.status,
		before: options.before,
		...(options.after ? { after: options.after } : {}),
		changedFiles: options.changedFiles,
		...(options.worker ? { worker: options.worker } : {}),
		...(options.reviewer ? { reviewer: options.reviewer } : {}),
		verification: options.verification,
		reason: options.reason,
		residualRisks: options.residualRisks,
	});
	const bundle = persistPilotReceipt(options.bundle, receipt);
	return {
		bundle,
		status: options.status,
		changedFiles: options.changedFiles,
		verification: options.verification,
		...(options.worker?.report ? { worker: options.worker.report } : {}),
		...(options.reviewer?.result ? { reviewer: options.reviewer.result } : {}),
		reason: options.reason,
	};
}

export async function runPrimarySolo(options: {
	bundle: PilotBundle;
	envelope: ExecutionEnvelope;
	workerTask: string;
	reviewerTask: (evidence: { changedFiles: string[]; diff: string; worker: PilotWorkerReport; verification: VerificationEvidence[] }) => string;
	dependencies: PrimarySoloDependencies;
	signal?: AbortSignal;
}): Promise<PrimarySoloRunResult> {
	const capture = options.dependencies.captureBaseline ?? captureGitBaseline;
	const changedFilesFor = options.dependencies.changedFiles ?? listPrimarySoloChangedFiles;
	const indexClean = options.dependencies.indexClean ?? isPrimarySoloIndexClean;
	const verify = options.dependencies.verify ?? ((command, cwd, signal) => runPilotVerification({
		command,
		cwd,
		signal,
		timeoutMs: options.envelope.verificationTimeoutMs,
	}));
	let before = options.envelope.baseline;
	let bundle = options.bundle;
	let after: GitBaseline | undefined;
	let changedFiles: string[] = [];
	let verification: VerificationEvidence[] = [];
	let worker: { requestId: string; runId?: string; report?: PilotWorkerReport } | undefined;
	let reviewer: { requestId: string; runId?: string; result?: PilotReviewResult } | undefined;
	try {
		if (options.envelope.verificationTimeoutMs !== PILOT_VERIFICATION_TIMEOUT_MS) {
			throw new PrimarySoloError("Pilot verification timeout policy changed after Work Gate authorization.");
		}
		requireNotCancelled(options.signal, "launch");
		before = capture(options.envelope.cwd);
		if (bundle.manifest.status !== "ready_for_work" || bundle.manifest.phase !== "ready") {
			throw new PrimarySoloError("Pilot Bundle is not ready for work.");
		}
		if (bundle.manifest.authorization?.digest !== options.envelope.digest) {
			throw new PrimarySoloError("Pilot Work has not been authorized for this Envelope.");
		}
		if (before.digest !== options.envelope.baseline.digest || before.status || !indexClean(options.envelope.cwd)) {
			throw new PrimarySoloError("Pilot Work baseline changed after authorization.");
		}

		const workerPreflightId = randomUUID();
		bundle = transition(bundle, "working", "work", { id: workerPreflightId, role: "worker", generation: bundle.manifest.revision + 1 });
		const workerRequest = makeRequest(options.envelope.worker, options.envelope.cwd, options.workerTask);
		const workerPolicy = await options.dependencies.preflight(workerRequest, workerPreflightId, options.signal);
		assertPolicyMatchesBinding(workerPolicy, options.envelope.worker, options.envelope.cwd);
		requireNotCancelled(options.signal, "Worker launch");
		const launchBaseline = capture(options.envelope.cwd);
		if (launchBaseline.digest !== options.envelope.baseline.digest || launchBaseline.status || !indexClean(options.envelope.cwd)) {
			throw new PrimarySoloError("Pilot Work baseline changed before Worker launch.");
		}
		assertVerificationDisclosureUnchanged(options.envelope);
		const workerLaunchId = randomUUID();
		bundle = transition(bundle, "working", "work", { id: workerLaunchId, role: "worker", generation: bundle.manifest.revision + 1 });
		const workerResponse = await options.dependencies.launch(workerRequest, workerPolicy, workerLaunchId, options.signal);
		const workerOutput = requireCompleted(workerResponse, "worker");
		requireNotCancelled(options.signal, "Worker execution");
		const workerReport = parsePilotWorkerReport(workerOutput);
		worker = { requestId: workerLaunchId, ...(workerResponse.runId ? { runId: workerResponse.runId } : {}), report: workerReport };

		after = capture(options.envelope.cwd);
		changedFiles = changedFilesFor(options.envelope.cwd);
		if (!indexClean(options.envelope.cwd)) throw new PrimarySoloError("Pilot worker modified the Git index; only unstaged changes are allowed.");
		assertChangedFilesInScope(options.envelope.cwd, changedFiles, options.envelope.worker.writeRoots);
		assertObservedMatchesWorker(workerReport, changedFiles);
		bundle = writePilotBundleArtifact(bundle, "execution", JSON.stringify({
			envelopeDigest: options.envelope.digest,
			beforeBaseline: before,
			afterWorkerBaseline: after,
			changedFiles,
			worker,
		}, null, 2));

		bundle = transition(bundle, "verifying", "verify");
		assertVerificationDisclosureUnchanged(options.envelope);
		for (const command of options.envelope.verificationCommands) {
			requireNotCancelled(options.signal, "verification");
			assertVerificationDisclosureUnchanged(options.envelope);
			const evidence = await verify(command, options.envelope.cwd, options.signal);
			verification.push(evidence);
			requireNotCancelled(options.signal, "verification");
			if (evidence.termination) {
				throw new PrimarySoloError(evidence.error ?? `Pilot verification ${evidence.termination}: ${command}`, evidence.termination === "cancelled" ? "cancelled" : "failed");
			}
			if (evidence.exitCode !== 0) throw new PrimarySoloError(`Pilot verification failed: ${command}`, "failed");
		}
		const afterVerification = capture(options.envelope.cwd);
		const changedAfterVerification = changedFilesFor(options.envelope.cwd);
		if (afterVerification.digest !== after.digest || !equalLists(changedAfterVerification, changedFiles) || !indexClean(options.envelope.cwd)) {
			throw new PrimarySoloError("Pilot verification changed the authorized project delta.", "failed");
		}

		const reviewDiff = capturePrimarySoloDiff(options.envelope.cwd, changedFiles);
		requireNotCancelled(options.signal, "review");
		const reviewerPreflightId = randomUUID();
		reviewer = { requestId: reviewerPreflightId };
		let reviewerResponse: PilotDelegationResponse | undefined;
		let reviewerResult: PilotReviewResult;
		let reviewerFailureStatus = "preflight_failed";
		try {
			bundle = transition(bundle, "reviewing", "review", { id: reviewerPreflightId, role: "reviewer", generation: bundle.manifest.revision + 1 });
			const reviewerRequest = makeRequest(options.envelope.reviewer, options.envelope.cwd, options.reviewerTask({ changedFiles, diff: reviewDiff, worker: workerReport, verification }));
			const reviewerPolicy = await options.dependencies.preflight(reviewerRequest, reviewerPreflightId, options.signal);
			assertPolicyMatchesBinding(reviewerPolicy, options.envelope.reviewer, options.envelope.cwd);
			requireNotCancelled(options.signal, "Reviewer launch");
			const reviewerLaunchId = randomUUID();
			bundle = transition(bundle, "reviewing", "review", { id: reviewerLaunchId, role: "reviewer", generation: bundle.manifest.revision + 1 });
			reviewer = { requestId: reviewerLaunchId };
			reviewerFailureStatus = "launch_failed";
			reviewerResponse = await options.dependencies.launch(reviewerRequest, reviewerPolicy, reviewerLaunchId, options.signal);
			reviewer = { requestId: reviewerLaunchId, ...(reviewerResponse.runId ? { runId: reviewerResponse.runId } : {}) };
			const reviewerOutput = requireCompleted(reviewerResponse, "reviewer");
			requireNotCancelled(options.signal, "review");
			reviewerResult = parsePilotReviewResult(reviewerOutput);
			reviewer = { ...reviewer, result: reviewerResult };
			bundle = writePilotBundleArtifact(bundle, "implementationReview", JSON.stringify(reviewerResult, null, 2));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const rawOutput = reviewerResponse?.output
				? Buffer.from(reviewerResponse.output).subarray(0, 64 * 1024).toString("utf8")
				: undefined;
			bundle = writePilotBundleArtifact(bundle, "implementationReview", JSON.stringify({
				schemaVersion: 1,
				status: "failed",
				requestId: reviewer?.requestId ?? reviewerPreflightId,
				...(reviewerResponse?.runId ? { runId: reviewerResponse.runId } : {}),
				responseStatus: reviewerResponse?.status ?? reviewerFailureStatus,
				error: reason,
				...(rawOutput ? { rawOutput } : {}),
			}, null, 2));
			throw error;
		}
		if (reviewerResult.verdict === "pass") {
			try {
				assertPilotAcceptanceEvidence(bundle.manifest.workPlan?.acceptance ?? [], reviewerResult);
			} catch (error) {
				throw new PrimarySoloError(error instanceof Error ? error.message : String(error));
			}
		}
		if (reviewerResult.verdict !== "pass") {
			throw new PrimarySoloError(`Pilot reviewer returned ${reviewerResult.verdict}.`);
		}
		const finalBaseline = capture(options.envelope.cwd);
		if (finalBaseline.digest !== afterVerification.digest || !equalLists(changedFilesFor(options.envelope.cwd), changedFiles) || !indexClean(options.envelope.cwd)) {
			throw new PrimarySoloError("Project baseline changed during fresh review.");
		}
		const receipt = receiptFromTerminal({
			bundle,
			envelope: options.envelope,
			status: "passed",
			before,
			after: finalBaseline,
			changedFiles,
			worker,
			reviewer,
			verification,
			residualRisks: reviewerResult.residualRisks,
		});
		bundle = persistPilotReceipt(bundle, receipt);
		return { bundle, status: "passed", changedFiles, verification, worker: workerReport, reviewer: reviewerResult };
	} catch (error) {
		const primaryError = error instanceof PrimarySoloError
			? error
			: new PrimarySoloError(error instanceof Error ? error.message : String(error), options.signal?.aborted ? "cancelled" : "failed");
		try {
			after = capture(options.envelope.cwd);
			changedFiles = changedFilesFor(options.envelope.cwd);
			return persistTerminal({
				bundle,
				envelope: options.envelope,
				status: primaryError.status,
				before,
				...(after ? { after } : {}),
				changedFiles,
				...(worker ? { worker } : {}),
				...(reviewer ? { reviewer } : {}),
				verification,
				reason: primaryError.message,
				residualRisks: [primaryError.message, ...(worker?.report?.residualRisks ?? []), ...(reviewer?.result?.residualRisks ?? [])],
			});
		} catch (receiptError) {
			throw new Error(`Pilot primary-solo failed (${primaryError.message}) and could not persist its receipt: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`);
		}
	}
}
