import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import * as envelopeModule from "../lib/envelope.ts";
import {
	assertCleanPrimarySoloBaseline,
	buildExecutionEnvelope,
	captureGitBaseline,
	commandArgs,
	sameExecutionEnvelope,
} from "../lib/envelope.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "pilot-envelope-"));
	roots.push(root);
	const project = path.join(root, "project");
	mkdirSync(path.join(project, "src"), { recursive: true });
	mkdirSync(path.join(project, "lib"));
	const run = (args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
	run(["init"]);
	run(["config", "user.email", "pilot@example.test"]);
	run(["config", "user.name", "Pilot Test"]);
	writeFileSync(path.join(project, "README.md"), "# Pilot\n", "utf8");
	writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: {
		pretest: "node pretest.js",
		test: "node --test",
		posttest: "node posttest.js",
		lint: "tsc --noEmit",
	} }), "utf8");
	run(["add", "."]);
	run(["commit", "-m", "initial"]);
	return { project };
}

function bindings(project: string) {
	return {
		worker: {
			agent: "pilot.worker",
			agentDefinitionHash: "a".repeat(64),
			policyDigest: "b".repeat(64),
			allowedTools: ["write", "read", "edit"],
			writeRoots: [path.join(project, "src")],
			expectedAgent: { filePath: "/profiles/worker.md", definitionHash: "a".repeat(64), source: "package" as const, packageName: "pilot", requireNoOverride: true },
		},
		reviewer: {
			agent: "pilot.reviewer",
			agentDefinitionHash: "c".repeat(64),
			policyDigest: "d".repeat(64),
			allowedTools: ["read", "grep", "find", "ls"],
			writeRoots: [],
			expectedAgent: { filePath: "/profiles/reviewer.md", definitionHash: "c".repeat(64), source: "package" as const, packageName: "pilot", requireNoOverride: true },
		},
	};
}

function build(project: string) {
	const baseline = captureGitBaseline(project);
	return buildExecutionEnvelope({
		runId: "run-1",
		sourceRevision: 3,
		cwd: project,
		pilotActivation: "manual",
		modePolicy: "edit",
		effectiveRoute: "edit",
		topology: "primary_solo",
		isolation: "none",
		requirements: { path: "requirements.md", sha256: "e".repeat(64), bytes: 10 },
		handoff: { path: "handoff.md", sha256: "f".repeat(64), bytes: 20 },
		baseline,
		...bindings(project),
		verificationCommands: ["npm test"],
	});
}

describe("Pilot execution Envelope", () => {
	test("content-addresses route, Bundle artifacts, baseline, profiles, scope, and validation", () => {
		const { project } = fixture();
		const first = build(project);
		const second = build(project);
		assert.equal(first.digest, second.digest);
		assert.equal(first.cwd, project);
		assert.deepEqual(first.worker.allowedTools, ["edit", "read", "write"]);
		assert.equal(sameExecutionEnvelope(first, second), true);

		const changed = buildExecutionEnvelope({ ...first, worker: { ...first.worker, writeRoots: [path.join(project, "src"), path.join(project, "lib")] } });
		assert.notEqual(changed.digest, first.digest);
		assert.equal(sameExecutionEnvelope(first, changed), false);
	});

	test("rejects non-canonical or escaping Worker write roots", () => {
		const { project } = fixture();
		const outside = path.join(path.dirname(project), "outside");
		mkdirSync(outside);
		const linked = path.join(project, "linked");
		symlinkSync(outside, linked, "dir");
		const baseline = captureGitBaseline(project);
		const input = {
			...build(project),
			baseline,
		};
		assert.throws(
			() => buildExecutionEnvelope({ ...input, worker: { ...input.worker, writeRoots: [linked] } }),
			/canonical|write root|outside/i,
		);
		assert.throws(
			() => buildExecutionEnvelope({ ...input, worker: { ...input.worker, writeRoots: [outside] } }),
			/outside|escapes/i,
		);
	});

	test("binds each verification command to every disclosed lifecycle script", () => {
		const { project } = fixture();
		const resolveVerificationScripts = (envelopeModule as unknown as {
			resolveVerificationScripts?: (cwd: string, commands: string[]) => Array<{
				command: string;
				script: string;
				lifecycleScripts: Array<{ name: string; script: string }>;
			}>;
		}).resolveVerificationScripts;
		assert.equal(typeof resolveVerificationScripts, "function");
		const scripts = resolveVerificationScripts!(project, ["npm test", "npm run lint"]);
		assert.deepEqual(scripts, [
			{
				command: "npm test",
				script: "node --test",
				lifecycleScripts: [
					{ name: "pretest", script: "node pretest.js" },
					{ name: "test", script: "node --test" },
					{ name: "posttest", script: "node posttest.js" },
				],
			},
			{
				command: "npm run lint",
				script: "tsc --noEmit",
				lifecycleScripts: [{ name: "lint", script: "tsc --noEmit" }],
			},
		]);
	});

	test("hashes the complete package.json used to resolve verification", () => {
		const { project } = fixture();
		const resolveVerificationDisclosure = (envelopeModule as unknown as {
			resolveVerificationDisclosure?: (cwd: string, commands: string[]) => { packageJsonSha256: string };
		}).resolveVerificationDisclosure;
		assert.equal(typeof resolveVerificationDisclosure, "function");
		const before = resolveVerificationDisclosure!(project, ["npm test"]);
		const packageJson = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(path.join(project, "package.json"), JSON.stringify({ ...packageJson, description: "changed after authorization" }), "utf8");
		const after = resolveVerificationDisclosure!(project, ["npm test"]);
		assert.match(before.packageJsonSha256, /^[a-f0-9]{64}$/);
		assert.notEqual(after.packageJsonSha256, before.packageJsonSha256);
	});

	test("rejects missing or malformed verification scripts", () => {
		const { project } = fixture();
		const resolveVerificationScripts = (envelopeModule as unknown as {
			resolveVerificationScripts?: (cwd: string, commands: string[]) => Array<{ command: string; script: string }>;
		}).resolveVerificationScripts;
		assert.equal(typeof resolveVerificationScripts, "function");
		assert.throws(() => resolveVerificationScripts!(project, ["npm run missing"]), /package script.*missing/i);
		writeFileSync(path.join(project, "package.json"), "not json\n", "utf8");
		assert.throws(() => resolveVerificationScripts!(project, ["npm test"]), /package.json/i);
	});

	test("changes baseline identity when existing untracked content changes", () => {
		const { project } = fixture();
		const untracked = path.join(project, "scratch.txt");
		writeFileSync(untracked, "one\n", "utf8");
		const before = captureGitBaseline(project);
		writeFileSync(untracked, "two\n", "utf8");
		const after = captureGitBaseline(project);
		assert.equal(before.status, after.status);
		assert.notEqual(before.digest, after.digest);
	});

	test("requires clean Git primary-solo baselines and package-manager verification", () => {
		const { project } = fixture();
		const baseline = captureGitBaseline(project);
		assert.doesNotThrow(() => assertCleanPrimarySoloBaseline(baseline));
		assert.deepEqual(commandArgs("npm run lint"), { command: "npm", args: ["run", "lint"] });

		writeFileSync(path.join(project, "README.md"), "changed\n", "utf8");
		assert.throws(() => assertCleanPrimarySoloBaseline(captureGitBaseline(project)), /clean Git worktree/);
		assert.throws(() => commandArgs("bash -c rm"), /only support/);
	});

	test("rejects a write-capable reviewer and a non-EDIT route", () => {
		const { project } = fixture();
		const envelope = build(project);
		assert.throws(() => buildExecutionEnvelope({ ...envelope, reviewer: { ...envelope.reviewer, allowedTools: ["read", "write"] } }), /reviewer must be read-only/);
		assert.throws(() => buildExecutionEnvelope({ ...envelope, effectiveRoute: "plan" as never }), /requires an EDIT route/);
	});
});
