import { commitPilotBundleTerminal, type BundleStatus, type PilotBundle } from "./bundle.ts";
import type { ExecutionEnvelope, GitBaseline } from "./envelope.ts";
import type { PilotReviewResult, PilotWorkerReport, VerificationEvidence } from "./review.ts";

export interface PilotPlanningReceipt {
	schemaVersion: 1;
	runId: string;
	status: "blocked" | "cancelled";
	phase: "planning";
	reason: string;
	createdAt: string;
}

export interface PilotReceipt {
	schemaVersion: 1;
	runId: string;
	status: Extract<BundleStatus, "passed" | "blocked" | "failed" | "cancelled">;
	envelopeDigest: string;
	baselineDigest: string;
	finalBaselineDigest?: string;
	changedFiles: string[];
	worker?: {
		requestId: string;
		runId?: string;
		report?: PilotWorkerReport;
	};
	reviewer?: {
		requestId: string;
		runId?: string;
		result?: PilotReviewResult;
	};
	verification: VerificationEvidence[];
	reason?: string;
	residualRisks: string[];
	createdAt: string;
}

export function createPilotReceipt(input: Omit<PilotReceipt, "schemaVersion" | "createdAt"> & { createdAt?: Date }): PilotReceipt {
	if (input.status === "passed") {
		if (!input.finalBaselineDigest) throw new Error("Passed Pilot receipt requires a final baseline digest.");
		if (!input.reviewer?.result || input.reviewer.result.verdict !== "pass") throw new Error("Passed Pilot receipt requires a passing reviewer verdict.");
		if (input.verification.some((entry) => entry.exitCode !== 0 || entry.termination)) throw new Error("Passed Pilot receipt requires passing verification.");
		if (input.changedFiles.length === 0) throw new Error("Passed Pilot receipt requires observed changes.");
	}
	return {
		schemaVersion: 1,
		runId: input.runId,
		status: input.status,
		envelopeDigest: input.envelopeDigest,
		baselineDigest: input.baselineDigest,
		...(input.finalBaselineDigest ? { finalBaselineDigest: input.finalBaselineDigest } : {}),
		changedFiles: [...new Set(input.changedFiles)].sort(),
		...(input.worker ? { worker: input.worker } : {}),
		...(input.reviewer ? { reviewer: input.reviewer } : {}),
		verification: [...input.verification],
		...(input.reason ? { reason: input.reason } : {}),
		residualRisks: [...new Set(input.residualRisks)],
		createdAt: (input.createdAt ?? new Date()).toISOString(),
	};
}

export function persistPilotReceipt(bundle: PilotBundle, receipt: PilotReceipt): PilotBundle {
	return commitPilotBundleTerminal(bundle, {
		status: receipt.status,
		...(receipt.reason ? { reason: receipt.reason } : {}),
		receipt: JSON.stringify(receipt, null, 2),
	});
}

export function createPilotPlanningReceipt(
	input: Omit<PilotPlanningReceipt, "schemaVersion" | "createdAt"> & { createdAt?: Date },
): PilotPlanningReceipt {
	return {
		schemaVersion: 1,
		runId: input.runId,
		status: input.status,
		phase: "planning",
		reason: input.reason,
		createdAt: (input.createdAt ?? new Date()).toISOString(),
	};
}

export function persistPilotPlanningReceipt(
	bundle: PilotBundle,
	input: Omit<PilotPlanningReceipt, "schemaVersion" | "runId" | "phase" | "createdAt"> & { createdAt?: Date },
): PilotBundle {
	const receipt = createPilotPlanningReceipt({
		runId: bundle.manifest.runId,
		phase: "planning",
		...input,
	});
	return commitPilotBundleTerminal(bundle, {
		status: receipt.status,
		reason: receipt.reason,
		receipt: JSON.stringify(receipt, null, 2),
	});
}

export function receiptFromTerminal(input: {
	bundle: PilotBundle;
	envelope: ExecutionEnvelope;
	status: Extract<BundleStatus, "passed" | "blocked" | "failed" | "cancelled">;
	before: GitBaseline;
	after?: GitBaseline;
	changedFiles?: string[];
	worker?: PilotReceipt["worker"];
	reviewer?: PilotReceipt["reviewer"];
	verification?: VerificationEvidence[];
	reason?: string;
	residualRisks?: string[];
}): PilotReceipt {
	return createPilotReceipt({
		runId: input.bundle.manifest.runId,
		status: input.status,
		envelopeDigest: input.envelope.digest,
		baselineDigest: input.before.digest,
		...(input.after ? { finalBaselineDigest: input.after.digest } : {}),
		changedFiles: input.changedFiles ?? [],
		...(input.worker ? { worker: input.worker } : {}),
		...(input.reviewer ? { reviewer: input.reviewer } : {}),
		verification: input.verification ?? [],
		...(input.reason ? { reason: input.reason } : {}),
		residualRisks: input.residualRisks ?? [],
	});
}
