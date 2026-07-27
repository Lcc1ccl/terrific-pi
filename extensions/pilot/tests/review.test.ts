import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import * as reviewModule from "../lib/review.ts";
import { parsePilotReviewResult, parsePilotWorkerReport, runPilotVerification } from "../lib/review.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for verification process state.");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("Pilot worker and review contracts", () => {
	test("parses worker and fresh reviewer reports with exact scope evidence", () => {
		assert.deepEqual(parsePilotWorkerReport(JSON.stringify({
			summary: "Implemented the command.",
			changedFiles: ["src/command.ts"],
			residualRisks: [],
		})), {
			summary: "Implemented the command.",
			changedFiles: ["src/command.ts"],
			residualRisks: [],
		});
		const review = parsePilotReviewResult(JSON.stringify({
			verdict: "pass",
			findings: [],
			validationGaps: [],
			scopeDrift: [],
			residualRisks: [],
			evidence: ["Reviewed src/command.ts"],
			acceptanceEvidence: [{ criterion: "Command is available.", evidence: "src/command.ts exports the command." }],
		}));
		assert.equal(review.verdict, "pass");
		assert.deepEqual((review as unknown as { acceptanceEvidence: unknown }).acceptanceEvidence, [
			{ criterion: "Command is available.", evidence: "src/command.ts exports the command." },
		]);
	});

	test("requires exact evidence for every approved acceptance criterion", () => {
		const assertPilotAcceptanceEvidence = (reviewModule as unknown as {
			assertPilotAcceptanceEvidence?: (expected: string[], result: unknown) => void;
		}).assertPilotAcceptanceEvidence;
		assert.equal(typeof assertPilotAcceptanceEvidence, "function");
		const result = parsePilotReviewResult(JSON.stringify({
			verdict: "pass",
			findings: [],
			validationGaps: [],
			scopeDrift: [],
			residualRisks: [],
			evidence: ["Reviewed the diff."],
			acceptanceEvidence: [
				{ criterion: "A", evidence: "diff line 1" },
				{ criterion: "B", evidence: "npm test" },
			],
		}));
		assert.doesNotThrow(() => assertPilotAcceptanceEvidence!(["A", "B"], result));
		assert.throws(() => assertPilotAcceptanceEvidence!(["A", "C"], result), /acceptance evidence/i);
		assert.throws(() => assertPilotAcceptanceEvidence!(["A"], result), /acceptance evidence/i);
	});

	test("rejects path traversal, malformed output, and self-contradictory passes", () => {
		assert.throws(() => parsePilotWorkerReport(JSON.stringify({ summary: "done", changedFiles: ["../secret"], residualRisks: [] })), /project-relative/);
		assert.throws(() => parsePilotReviewResult(JSON.stringify({ verdict: "pass", findings: ["bug"], validationGaps: [], scopeDrift: [], residualRisks: [], evidence: [], acceptanceEvidence: [{ criterion: "A", evidence: "B" }] })), /pass verdict/);
		assert.throws(() => parsePilotReviewResult("not json"), /did not return a JSON object/);
	});

	test("does not spawn verification when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			runPilotVerification({ command: "npm test", cwd: process.cwd(), signal: controller.signal }),
			/cancelled/i,
		);
	});

	test("kills the complete verification process group before cancellation returns", { timeout: 10_000 }, async () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(path.join(tmpdir(), "pilot-verification-cancel-"));
		roots.push(root);
		writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node parent.cjs" } }), "utf8");
		writeFileSync(path.join(root, "child.cjs"), [
			"const fs = require('node:fs');",
			"process.on('SIGTERM', () => {});",
			"fs.writeFileSync('child.pid', String(process.pid));",
			"setInterval(() => {}, 1000);",
		].join("\n"), "utf8");
		writeFileSync(path.join(root, "parent.cjs"), [
			"const { spawn } = require('node:child_process');",
			"spawn(process.execPath, ['child.cjs'], { stdio: 'ignore' });",
			"process.on('SIGTERM', () => process.exit(0));",
			"setInterval(() => {}, 1000);",
		].join("\n"), "utf8");
		const controller = new AbortController();
		const verification = runPilotVerification({ command: "npm test", cwd: root, signal: controller.signal });
		const pidPath = path.join(root, "child.pid");
		await waitFor(() => existsSync(pidPath));
		const childPid = Number(readFileSync(pidPath, "utf8"));
		try {
			assert.equal(isAlive(childPid), true);
			controller.abort();
			const evidence = await verification;
			assert.equal(evidence.termination, "cancelled");
			assert.equal(evidence.exitCode, null);
			assert.match(evidence.error ?? "", /cancelled/i);
			assert.equal(isAlive(childPid), false, "cancellation returned before the process group terminated");
		} finally {
			if (isAlive(childPid)) process.kill(childPid, "SIGKILL");
		}
	});

	test("kills the complete verification process group when the deadline expires", { timeout: 10_000 }, async () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(path.join(tmpdir(), "pilot-verification-timeout-"));
		roots.push(root);
		writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node parent.cjs" } }), "utf8");
		writeFileSync(path.join(root, "child.cjs"), [
			"const fs = require('node:fs');",
			"process.on('SIGTERM', () => {});",
			"fs.writeFileSync('child.pid', String(process.pid));",
			"setInterval(() => {}, 1000);",
		].join("\n"), "utf8");
		writeFileSync(path.join(root, "parent.cjs"), [
			"const { spawn } = require('node:child_process');",
			"spawn(process.execPath, ['child.cjs'], { stdio: 'ignore' });",
			"process.on('SIGTERM', () => process.exit(0));",
			"setInterval(() => {}, 1000);",
		].join("\n"), "utf8");
		const verification = runPilotVerification({ command: "npm test", cwd: root, timeoutMs: 1_000 });
		const pidPath = path.join(root, "child.pid");
		await waitFor(() => existsSync(pidPath));
		const childPid = Number(readFileSync(pidPath, "utf8"));
		try {
			const evidence = await verification;
			assert.equal(evidence.termination, "timed_out");
			assert.equal(evidence.exitCode, null);
			assert.match(evidence.error ?? "", /timed out/i);
			assert.equal(isAlive(childPid), false, "deadline returned before the process group terminated");
		} finally {
			if (isAlive(childPid)) process.kill(childPid, "SIGKILL");
		}
	});

	test("runs only the restricted package-manager verification command shape", async () => {
		const result = await runPilotVerification({ command: "npm run __pilot_missing__", cwd: process.cwd() });
		assert.equal(typeof result.durationMs, "number");
		assert.equal(result.command, "npm run __pilot_missing__");
		assert.notEqual(result.exitCode, 0);
	});
});
