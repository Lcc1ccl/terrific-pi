import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createPilotPlanningReceipt, createPilotReceipt } from "../lib/receipt.ts";

const base = {
	runId: "run-1",
	envelopeDigest: "a".repeat(64),
	baselineDigest: "b".repeat(64),
	changedFiles: ["src/file.ts"],
	verification: [{ command: "npm test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 12 }],
	reviewer: {
		requestId: "review-1",
		result: {
			verdict: "pass" as const,
			findings: [],
			validationGaps: [],
			scopeDrift: [],
			residualRisks: [],
			evidence: ["read diff"],
			acceptanceEvidence: [{ criterion: "File is updated.", evidence: "src/file.ts changed." }],
		},
	},
	residualRisks: [],
};

describe("Pilot receipt", () => {
	test("requires reconciled evidence for a passed receipt", () => {
		const receipt = createPilotReceipt({ ...base, status: "passed", finalBaselineDigest: "c".repeat(64), createdAt: new Date("2026-07-23T00:00:00.000Z") });
		assert.equal(receipt.status, "passed");
		assert.equal(receipt.schemaVersion, 1);
		assert.equal(receipt.createdAt, "2026-07-23T00:00:00.000Z");
	});

	test("writes a planning terminal receipt without an execution Envelope", () => {
		const receipt = createPilotPlanningReceipt({
			runId: "run-1",
			status: "cancelled",
			phase: "planning",
			reason: "Planner cancelled",
			createdAt: new Date("2026-07-23T00:00:00.000Z"),
		});
		assert.deepEqual(receipt, {
			schemaVersion: 1,
			runId: "run-1",
			status: "cancelled",
			phase: "planning",
			reason: "Planner cancelled",
			createdAt: "2026-07-23T00:00:00.000Z",
		});
	});

	test("permits a terminal blocked receipt but never labels failed evidence passed", () => {
		const blocked = createPilotReceipt({ ...base, status: "blocked", reason: "Worker scope drift", verification: [] });
		assert.equal(blocked.status, "blocked");
		assert.throws(() => createPilotReceipt({ ...base, status: "passed", finalBaselineDigest: "c".repeat(64), verification: [{ ...base.verification[0]!, exitCode: 1 }] }), /passing verification/);
		assert.throws(() => createPilotReceipt({ ...base, status: "passed", finalBaselineDigest: "c".repeat(64), changedFiles: [] }), /observed changes/);
	});
});
