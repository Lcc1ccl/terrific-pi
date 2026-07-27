import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import {
	commitPilotBundleTerminal,
	createPilotBundle,
	markPilotBundleReady,
	openPilotBundle,
	readPilotBundleArtifact,
	resolvePilotRunsRoot,
	updatePilotBundle,
	writePilotBundleArtifact,
} from "../lib/bundle.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "pilot-bundle-"));
	roots.push(root);
	const common = path.join(root, "repo.git");
	const project = path.join(root, "project");
	mkdirSync(common, { recursive: true });
	mkdirSync(project, { recursive: true });
	return { root, common, project };
}

describe("Pilot Bundle", () => {
	test("stores canonical artifacts under the Git common directory, not the project tree", () => {
		const { common, project } = fixture();
		let bundle = createPilotBundle({
			gitCommonDir: common,
			cwd: project,
			originalPrompt: "Add a small command.",
			modePolicy: "edit",
			pilotActivation: "manual",
			effectiveRoute: "edit",
			runId: "run-1",
			now: new Date("2026-07-23T00:00:00.000Z"),
		});
		assert.equal(bundle.dir, path.join(resolvePilotRunsRoot(common), "run-1"));
		assert.equal(statSync(bundle.dir).mode & 0o777, 0o700);
		assert.equal(bundle.manifest.revision, 0);
		assert.equal(existsSync(path.join(project, ".pi", "pilot")), false);

		bundle = writePilotBundleArtifact(bundle, "requirements", "# Requirements\n\nGoal: add a command.");
		bundle = writePilotBundleArtifact(bundle, "handoff", "# Handoff\n\nScope: src/");
		bundle = markPilotBundleReady(bundle);

		assert.equal(bundle.manifest.status, "ready_for_work");
		assert.equal(bundle.manifest.phase, "ready");
		assert.equal(bundle.manifest.revision, 3);
		assert.match(readPilotBundleArtifact(bundle, "requirements"), /Goal: add a command/);
		assert.equal(openPilotBundle(bundle.dir).manifest.handoffFingerprint, bundle.manifest.artifacts.handoff?.sha256);
	});

	test("rejects stale writers and detects artifact tampering on reopen", () => {
		const { common, project } = fixture();
		const original = createPilotBundle({
			gitCommonDir: common,
			cwd: project,
			originalPrompt: "Change one file.",
			modePolicy: "edit",
			pilotActivation: "manual",
			effectiveRoute: "edit",
			runId: "run-2",
		});
		const updated = writePilotBundleArtifact(original, "requirements", "# Requirements\n\nGoal: change one file.");
		assert.throws(() => updatePilotBundle(original, (current) => ({ ...current, status: "blocked", phase: "terminal" })), /changed concurrently/);
		assert.throws(() => writePilotBundleArtifact(original, "requirements", "# Requirements\n\nLoser content."), /changed concurrently/);
		assert.match(readPilotBundleArtifact(updated, "requirements"), /Goal: change one file/);

		const requirements = path.join(updated.dir, "requirements.md");
		writeFileSync(requirements, "tampered\n", "utf8");
		assert.throws(() => readPilotBundleArtifact(updated, "requirements"), /integrity check failed/);
	});

	test("rejects symlinked runs roots and artifact directories", () => {
		const { root, common, project } = fixture();
		const outsideRuns = path.join(root, "outside-runs");
		mkdirSync(outsideRuns);
		symlinkSync(outsideRuns, path.join(common, "pilot"), "dir");
		assert.throws(() => createPilotBundle({
			gitCommonDir: common,
			cwd: project,
			originalPrompt: "Escape the Bundle root.",
			modePolicy: "edit",
			pilotActivation: "manual",
			effectiveRoute: "edit",
			runId: "run-symlink-root",
		}), /symlink|secure directory/i);
		assert.equal(existsSync(path.join(outsideRuns, "runs", "run-symlink-root")), false);

		rmSync(path.join(common, "pilot"));
		const bundle = createPilotBundle({
			gitCommonDir: common,
			cwd: project,
			originalPrompt: "Escape an artifact directory.",
			modePolicy: "edit",
			pilotActivation: "manual",
			effectiveRoute: "edit",
			runId: "run-symlink-artifact",
		});
		const outsideReviews = path.join(root, "outside-reviews");
		mkdirSync(outsideReviews);
		symlinkSync(outsideReviews, path.join(bundle.dir, "reviews"), "dir");
		assert.throws(() => writePilotBundleArtifact(bundle, "implementationReview", "{}"), /symlink|secure directory/i);
		assert.equal(existsSync(path.join(outsideReviews, "implementation-01.json")), false);
	});

	test("commits the terminal receipt ref and lifecycle state in one revision", () => {
		const { common, project } = fixture();
		const bundle = createPilotBundle({
			gitCommonDir: common,
			cwd: project,
			originalPrompt: "Cancel this run.",
			modePolicy: "edit",
			pilotActivation: "manual",
			effectiveRoute: "edit",
			runId: "run-terminal",
		});
		const terminal = commitPilotBundleTerminal(bundle, {
			status: "cancelled",
			reason: "Cancelled by test.",
			receipt: '{"status":"cancelled"}',
		});
		assert.equal(terminal.manifest.revision, 1);
		assert.equal(terminal.manifest.status, "cancelled");
		assert.equal(terminal.manifest.phase, "terminal");
		assert.ok(terminal.manifest.artifacts.receipt);
		assert.match(readPilotBundleArtifact(terminal, "receipt"), /cancelled/);
	});

	test("refuses malformed manifests and unresolved decisions at the ready gate", () => {
		const { common, project } = fixture();
		let bundle = createPilotBundle({
			gitCommonDir: common,
			cwd: project,
			originalPrompt: "Change one file.",
			modePolicy: "edit",
			pilotActivation: "manual",
			effectiveRoute: "edit",
			runId: "run-3",
		});
		bundle = writePilotBundleArtifact(bundle, "requirements", "# Requirements\n\nGoal: change one file.");
		bundle = writePilotBundleArtifact(bundle, "handoff", "# Handoff\n\nScope: src/");
		bundle = updatePilotBundle(bundle, (current) => ({ ...current, needsDecision: "Choose a storage format." }));
		assert.throws(() => markPilotBundleReady(bundle), /unresolved decision/);

		writeFileSync(path.join(bundle.dir, "manifest.json"), "{ bad\n", "utf8");
		assert.throws(() => openPilotBundle(bundle.dir), /Could not load/);
	});
});
