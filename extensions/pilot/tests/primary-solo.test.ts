import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { createPilotBundle, readPilotBundleArtifact, updatePilotBundle } from "../lib/bundle.ts";
import { buildExecutionEnvelope, captureGitBaseline, resolveGitCommonDir } from "../lib/envelope.ts";
import { materializePilotPlan, parsePilotPlanningResult } from "../lib/planning.ts";
import { capturePrimarySoloDiff, runPrimarySolo, type PrimarySoloDependencies } from "../lib/primary-solo.ts";
import { runPilotVerification } from "../lib/review.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "pilot-primary-solo-"));
	roots.push(root);
	const project = path.join(root, "project");
	mkdirSync(path.join(project, "src"), { recursive: true });
	const git = (args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
	git(["init"]);
	git(["config", "user.email", "pilot@example.test"]);
	git(["config", "user.name", "Pilot Test"]);
	writeFileSync(path.join(project, "src", "existing.ts"), "export const value = 1;\n", "utf8");
	writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node --version" } }), "utf8");
	git(["add", "."]);
	git(["commit", "-m", "initial"]);
	const plan = parsePilotPlanningResult(JSON.stringify({
		goal: "Change the existing module.",
		scope: ["src/existing.ts"],
		nonGoals: [],
		acceptance: ["The module exports the new value."],
		writeRoots: ["src"],
		verificationCommands: ["npm test"],
		risks: [],
	}));
	let bundle = createPilotBundle({
		gitCommonDir: resolveGitCommonDir(project),
		cwd: project,
		originalPrompt: "Change the module.",
		modePolicy: "edit",
		pilotActivation: "manual",
		effectiveRoute: "edit",
		runId: "run-1",
	});
	bundle = materializePilotPlan(bundle, plan);
	const baseline = captureGitBaseline(project);
	const envelope = buildExecutionEnvelope({
		runId: bundle.manifest.runId,
		sourceRevision: bundle.manifest.revision,
		cwd: project,
		pilotActivation: "manual",
		modePolicy: "edit",
		effectiveRoute: "edit",
		topology: "primary_solo",
		isolation: "none",
		requirements: bundle.manifest.artifacts.requirements!,
		handoff: bundle.manifest.artifacts.handoff!,
		baseline,
		worker: {
			agent: "pilot.worker",
			agentDefinitionHash: "a".repeat(64),
			policyDigest: "b".repeat(64),
			allowedTools: ["read", "grep", "find", "ls", "edit", "write"],
			writeRoots: [path.join(project, "src")],
			expectedAgent: { filePath: "/profiles/worker.md", definitionHash: "a".repeat(64), source: "package", packageName: "pilot", requireNoOverride: true },
		},
		reviewer: {
			agent: "pilot.reviewer",
			agentDefinitionHash: "c".repeat(64),
			policyDigest: "d".repeat(64),
			allowedTools: ["read", "grep", "find", "ls"],
			writeRoots: [],
			expectedAgent: { filePath: "/profiles/reviewer.md", definitionHash: "c".repeat(64), source: "package", packageName: "pilot", requireNoOverride: true },
		},
		verificationCommands: ["npm test"],
	});
	bundle = updatePilotBundle(bundle, (current) => ({
		...current,
		authorization: { digest: envelope.digest, envelope: envelope as unknown as Record<string, unknown>, authorizedAt: new Date().toISOString() },
	}));
	return { project, bundle, envelope };
}

function dependencies(project: string, options: {
	outsideScope?: boolean;
	verificationExitCode?: number;
	verificationMutates?: boolean;
	mutatePackageScript?: boolean;
	workerCreatesUntracked?: boolean;
	workerStages?: boolean;
	verificationRewritesUntracked?: boolean;
	reviewerCriterion?: string;
	workerFilename?: string;
	workerResidualRisks?: string[];
} = {}): PrimarySoloDependencies {
	return {
		async preflight(request) {
			const worker = request.agent === "pilot.worker";
			return {
				version: 1,
				agent: request.agent,
				agentDefinitionHash: worker ? "a".repeat(64) : "c".repeat(64),
				cwd: project,
				allowedTools: [...request.allowedTools].sort(),
				writeRoots: request.writeRoots.map((root) => path.resolve(project, root)).sort(),
				expectedAgent: { ...request.expectedAgent!, requireNoOverride: true },
				digest: worker ? "b".repeat(64) : "d".repeat(64),
				launchId: worker ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002",
				expiresAt: Date.now() + 60_000,
			};
		},
		async launch(request) {
			if (request.agent === "pilot.worker") {
				const relative = options.outsideScope ? "outside.ts" : options.workerFilename ?? "src/existing.ts";
				writeFileSync(path.join(project, relative), "export const value = 2;\n", "utf8");
				const changedFiles = [relative];
				if (options.workerCreatesUntracked) {
					writeFileSync(path.join(project, "src", "generated.txt"), "before\n", "utf8");
					changedFiles.push("src/generated.txt");
				}
				if (options.mutatePackageScript) {
					writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node malicious.js" } }), "utf8");
					changedFiles.push("package.json");
				}
				if (options.workerStages) execFileSync("git", ["add", "--", relative], { cwd: project });
				return {
					version: 1,
					requestId: "worker-launch",
					status: "completed",
					runId: "worker-run",
					output: JSON.stringify({ summary: "Changed the module.", changedFiles, residualRisks: options.workerResidualRisks ?? [] }),
				};
			}
			return {
				version: 1,
				requestId: "reviewer-launch",
				status: "completed",
				runId: "reviewer-run",
				output: JSON.stringify({
					verdict: "pass",
					findings: [],
					validationGaps: [],
					scopeDrift: [],
					residualRisks: [],
					evidence: ["Reviewed changed file."],
					acceptanceEvidence: [{
						criterion: options.reviewerCriterion ?? "The module exports the new value.",
						evidence: "src/existing.ts exports value 2.",
					}],
				}),
			};
		},
		async verify(command) {
			if (options.verificationMutates) writeFileSync(path.join(project, "generated.txt"), "generated\n", "utf8");
			if (options.verificationRewritesUntracked) writeFileSync(path.join(project, "src", "generated.txt"), "after\n", "utf8");
			return { command, exitCode: options.verificationExitCode ?? 0, stdout: "ok", stderr: "", durationMs: 1 };
		},
	};
}

describe("Pilot primary-solo transaction", () => {
	test("requires an authorized unchanged Envelope, then writes execution, review, and passed receipt", async () => {
		const { project, bundle, envelope } = fixture();
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement the approved handoff.",
			reviewerTask: () => "Review the observed delta.",
			dependencies: dependencies(project, { workerResidualRisks: ["Declared verification has not run yet."] }),
		});
		assert.equal(result.status, "passed");
		assert.deepEqual(result.changedFiles, ["src/existing.ts"]);
		assert.equal(result.bundle.manifest.status, "passed");
		assert.match(readPilotBundleArtifact(result.bundle, "execution"), /worker-run/);
		assert.match(readPilotBundleArtifact(result.bundle, "implementationReview"), /"pass"/);
		assert.match(readPilotBundleArtifact(result.bundle, "receipt"), /"passed"/);
		const receipt = JSON.parse(readPilotBundleArtifact(result.bundle, "receipt")) as { residualRisks: string[]; worker?: { report?: { residualRisks: string[] } } };
		assert.deepEqual(receipt.worker?.report?.residualRisks, ["Declared verification has not run yet."]);
		assert.deepEqual(receipt.residualRisks, [], "passed receipt risks must reflect the Reviewer's post-verification reconciliation");
		assert.equal(existsSync(path.join(project, ".git", "index.lock")), false);
	});

	test("passes the actual Git diff to the fresh reviewer", async () => {
		const { project, bundle, envelope } = fixture();
		let observedDiff = "";
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: (evidence: any) => {
				observedDiff = evidence.diff;
				return "Review.";
			},
			dependencies: dependencies(project),
		});
		assert.equal(result.status, "passed");
		assert.match(observedDiff, /diff --git a\/src\/existing\.ts b\/src\/existing\.ts/);
		assert.match(observedDiff, /-export const value = 1/);
		assert.match(observedDiff, /\+export const value = 2/);
	});

	test("treats a newline in a Git filename as one observed path", async () => {
		const { project, bundle, envelope } = fixture();
		const filename = "src/line\nbreak.ts";
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: dependencies(project, { workerFilename: filename }),
		});
		assert.equal(result.status, "passed");
		assert.deepEqual(result.changedFiles, [filename]);
	});

	test("treats pathspec-magic filenames as literal review paths", () => {
		const { project } = fixture();
		const filename = ":(literal)review.ts";
		writeFileSync(path.join(project, filename), "literal pathspec content\n", "utf8");
		const diff = capturePrimarySoloDiff(project, [filename]);
		assert.match(diff, /literal pathspec content/);
		assert.match(diff, /review\.ts/);
	});

	test("captures untracked additions as reviewable Git diff evidence", () => {
		const { project } = fixture();
		writeFileSync(path.join(project, "src", "new.ts"), "export const added = true;\n", "utf8");
		const diff = capturePrimarySoloDiff(project, ["src/new.ts"]);
		assert.match(diff, /new file mode/);
		assert.match(diff, /\+export const added = true/);
	});

	test("persists a structured review failure artifact for malformed Reviewer output", async () => {
		const { project, bundle, envelope } = fixture();
		const baseDependencies = dependencies(project);
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: {
				...baseDependencies,
				async launch(...args) {
					if (args[0].agent === "pilot.reviewer") {
						return { version: 1, requestId: args[2], status: "completed", runId: "bad-review", output: "not json" };
					}
					return baseDependencies.launch(...args);
				},
			},
		});
		assert.equal(result.status, "failed");
		const artifact = readPilotBundleArtifact(result.bundle, "implementationReview");
		assert.match(artifact, /"status": "failed"/);
		assert.match(artifact, /did not return a JSON object/);
		assert.match(artifact, /"runId": "bad-review"/);
	});

	test("persists a structured review failure artifact when Reviewer preflight fails", async () => {
		const { project, bundle, envelope } = fixture();
		const baseDependencies = dependencies(project);
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: {
				...baseDependencies,
				async preflight(...args) {
					if (args[0].agent === "pilot.reviewer") throw new Error("Reviewer profile is shadowed.");
					return baseDependencies.preflight(...args);
				},
			},
		});
		assert.equal(result.status, "failed");
		const artifact = readPilotBundleArtifact(result.bundle, "implementationReview");
		assert.match(artifact, /"status": "failed"/);
		assert.match(artifact, /"responseStatus": "preflight_failed"/);
		assert.match(artifact, /Reviewer profile is shadowed/);
	});

	test("blocks a pass whose acceptance evidence does not match the approved criteria", async () => {
		const { project, bundle, envelope } = fixture();
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: dependencies(project, { reviewerCriterion: "A different criterion." }),
		});
		assert.equal(result.status, "blocked");
		assert.match(result.reason ?? "", /acceptance evidence/i);
	});

	test("blocks package script drift before any verification command executes", async () => {
		const { project, bundle, envelope } = fixture();
		const broadEnvelope = buildExecutionEnvelope({
			...envelope,
			worker: { ...envelope.worker, writeRoots: [project] },
		});
		const authorized = updatePilotBundle(bundle, (current) => ({
			...current,
			authorization: { digest: broadEnvelope.digest, envelope: broadEnvelope as unknown as Record<string, unknown>, authorizedAt: new Date().toISOString() },
		}));
		const baseDependencies = dependencies(project, { mutatePackageScript: true });
		let verificationCalls = 0;
		const result = await runPrimarySolo({
			bundle: authorized,
			envelope: broadEnvelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: {
				...baseDependencies,
				async verify(...args) {
					verificationCalls++;
					return baseDependencies.verify!(...args);
				},
			},
		});
		assert.equal(result.status, "blocked");
		assert.equal(verificationCalls, 0);
		assert.match(result.reason ?? "", /package.json|verification script|disclosure/i);
	});

	test("recaptures the final failed delta after verification mutates the project", async () => {
		const { project, bundle, envelope } = fixture();
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: dependencies(project, { verificationExitCode: 1, verificationMutates: true }),
		});
		assert.equal(result.status, "failed");
		assert.deepEqual(result.changedFiles, ["generated.txt", "src/existing.ts"]);
		const receipt = JSON.parse(readPilotBundleArtifact(result.bundle, "receipt")) as { changedFiles: string[]; finalBaselineDigest?: string };
		assert.deepEqual(receipt.changedFiles, ["generated.txt", "src/existing.ts"]);
		assert.equal(typeof receipt.finalBaselineDigest, "string");
	});

	test("fails when verification rewrites existing untracked content", async () => {
		const { project, bundle, envelope } = fixture();
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: dependencies(project, { workerCreatesUntracked: true, verificationRewritesUntracked: true }),
		});
		assert.equal(result.status, "failed");
		assert.match(result.reason ?? "", /verification changed the authorized project delta/i);
	});

	test("rechecks the authorized baseline after Worker preflight and before launch", async () => {
		const { project, bundle, envelope } = fixture();
		const baseDependencies = dependencies(project);
		let workerLaunches = 0;
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: {
				...baseDependencies,
				async preflight(...args) {
					const resolved = await baseDependencies.preflight(...args);
					if (args[0].agent === "pilot.worker") writeFileSync(path.join(project, "src", "existing.ts"), "external drift\n", "utf8");
					return resolved;
				},
				async launch(...args) {
					if (args[0].agent === "pilot.worker") workerLaunches++;
					return baseDependencies.launch(...args);
				},
			},
		});
		assert.equal(result.status, "blocked");
		assert.equal(workerLaunches, 0);
		assert.match(result.reason ?? "", /baseline|authorization/i);
	});

	test("does not launch a worker before exact authorization", async () => {
		const { project, bundle, envelope } = fixture();
		let preflightCalls = 0;
		const guarded = dependencies(project);
		const result = await runPrimarySolo({
			bundle: updatePilotBundle(bundle, (current) => ({ ...current, authorization: undefined })),
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: { ...guarded, async preflight(...args) { preflightCalls++; return guarded.preflight(...args); } },
		});
		assert.equal(result.status, "blocked");
		assert.equal(preflightCalls, 0);
		assert.match(readPilotBundleArtifact(result.bundle, "receipt"), /not been authorized/);
	});

	test("blocks a Worker that modifies the Git index", async () => {
		const { project, bundle, envelope } = fixture();
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: dependencies(project, { workerStages: true }),
		});
		assert.equal(result.status, "blocked");
		assert.match(result.reason ?? "", /modified the Git index/);
		assert.match(readPilotBundleArtifact(result.bundle, "receipt"), /modified the Git index/);
	});

	test("blocks scope drift and persists a non-passed receipt", async () => {
		const { project, bundle, envelope } = fixture();
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: dependencies(project, { outsideScope: true }),
		});
		assert.equal(result.status, "blocked");
		assert.match(result.reason ?? "", /outside the authorized write scope/);
		assert.match(readPilotBundleArtifact(result.bundle, "receipt"), /outside the authorized write scope/);
	});

	test("maps cancellation during verification to cancelled and skips review", async () => {
		const { project, bundle, envelope } = fixture();
		const controller = new AbortController();
		const baseDependencies = dependencies(project);
		let reviewerLaunches = 0;
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			signal: controller.signal,
			dependencies: {
				...baseDependencies,
				async verify(command) {
					controller.abort();
					return { command, exitCode: 0, stdout: "cancelled late", stderr: "", durationMs: 1 };
				},
				async launch(...args) {
					if (args[0].agent === "pilot.reviewer") reviewerLaunches++;
					return baseDependencies.launch(...args);
				},
			},
		});
		assert.equal(result.status, "cancelled");
		assert.equal(reviewerLaunches, 0);
		assert.match(readPilotBundleArtifact(result.bundle, "receipt"), /"cancelled"/);
	});

	test("records timed-out verification evidence in the terminal receipt", { timeout: 10_000 }, async () => {
		if (process.platform === "win32") return;
		const { project, bundle, envelope } = fixture();
		const verificationRoot = mkdtempSync(path.join(tmpdir(), "pilot-primary-timeout-"));
		roots.push(verificationRoot);
		writeFileSync(path.join(verificationRoot, "package.json"), JSON.stringify({ scripts: { test: "printf 'started\\n'; printf 'still running\\n' >&2; node hang.cjs" } }), "utf8");
		writeFileSync(path.join(verificationRoot, "hang.cjs"), [
			"process.on('SIGTERM', () => {});",
			"setInterval(() => {}, 1000);",
		].join("\n"), "utf8");
		const baseDependencies = dependencies(project);
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: {
				...baseDependencies,
				verify: (command, _cwd, signal) => runPilotVerification({ command, cwd: verificationRoot, signal, timeoutMs: 300 }),
			},
		});
		assert.equal(result.status, "failed");
		assert.match(result.reason ?? "", /timed out/i);
		const receipt = JSON.parse(readPilotBundleArtifact(result.bundle, "receipt")) as {
			verification: Array<{ command: string; exitCode: number | null; stdout: string; stderr: string; durationMs: number; termination?: string; error?: string }>;
		};
		assert.equal(receipt.verification.length, 1);
		assert.equal(receipt.verification[0]?.command, "npm test");
		assert.equal(receipt.verification[0]?.exitCode, null);
		assert.equal(receipt.verification[0]?.termination, "timed_out");
		assert.match(receipt.verification[0]?.stdout ?? "", /started/);
		assert.match(receipt.verification[0]?.stderr ?? "", /still running/);
		assert.ok((receipt.verification[0]?.durationMs ?? 0) >= 300);
	});

	test("does not pass when selected verification fails", async () => {
		const { project, bundle, envelope } = fixture();
		const result = await runPrimarySolo({
			bundle,
			envelope,
			workerTask: "Implement.",
			reviewerTask: () => "Review.",
			dependencies: dependencies(project, { verificationExitCode: 1 }),
		});
		assert.equal(result.status, "failed");
		assert.match(result.reason ?? "", /verification failed/);
	});
});
