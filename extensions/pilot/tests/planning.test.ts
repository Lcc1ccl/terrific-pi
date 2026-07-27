import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { createPilotBundle, readPilotBundleArtifact } from "../lib/bundle.ts";
import {
	materializePilotPlan,
	parsePilotPlanningResult,
	validateVerificationCommand,
} from "../lib/planning.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bundle() {
	const root = mkdtempSync(path.join(tmpdir(), "pilot-planning-"));
	roots.push(root);
	const common = path.join(root, "repo.git");
	const project = path.join(root, "project");
	mkdirSync(path.join(project, "src"), { recursive: true });
	mkdirSync(common, { recursive: true });
	return createPilotBundle({
		gitCommonDir: common,
		cwd: project,
		originalPrompt: "Add a command.",
		modePolicy: "auto",
		pilotActivation: "auto",
		effectiveRoute: "edit",
		runId: "plan-1",
	});
}

const validOutput = `\`\`\`json
{
  "goal": "Add a small command.",
  "scope": ["src/command.ts"],
  "nonGoals": ["Do not change public APIs."],
  "acceptance": ["npm test passes"],
  "writeRoots": ["src"],
  "verificationCommands": ["npm test"],
  "risks": ["Existing command behavior must remain stable."]
}
\`\`\``;

describe("Pilot planning artifact", () => {
	test("parses a constrained planner contract and materializes a ready Bundle", () => {
		const plan = parsePilotPlanningResult(validOutput);
		assert.deepEqual(plan.writeRoots, ["src"]);
		assert.deepEqual(plan.verificationCommands, ["npm test"]);

		const ready = materializePilotPlan(bundle(), plan);
		assert.equal(ready.manifest.status, "ready_for_work");
		assert.equal(ready.manifest.handoffFingerprint, ready.manifest.artifacts.handoff?.sha256);
		assert.match(readPilotBundleArtifact(ready, "requirements"), /Approved Scope/);
		assert.match(readPilotBundleArtifact(ready, "handoff"), /Write Roots/);
	});

	test("blocks a Bundle when planning needs a human decision", () => {
		const plan = parsePilotPlanningResult(validOutput.replace('"risks":', '"needsDecision": "Choose the compatibility behavior.",\n  "risks":'));
		const blocked = materializePilotPlan(bundle(), plan);
		assert.equal(blocked.manifest.status, "blocked");
		assert.equal(blocked.manifest.needsDecision, "Choose the compatibility behavior.");
	});

	test("rejects path traversal, arbitrary command execution, and malformed contracts", () => {
		assert.throws(() => validateVerificationCommand("rm -rf ."), /only support/);
		assert.throws(() => parsePilotPlanningResult(validOutput.replace('"src"', '"../outside"')), /must not escape/);
		assert.throws(() => parsePilotPlanningResult(validOutput.replace('"acceptance": ["npm test passes"]', '"acceptance": []')), /acceptance must be a non-empty/);
		assert.throws(() => parsePilotPlanningResult(validOutput.replace('"verificationCommands": ["npm test"]', '"verificationCommands": ["node -e process.exit()"]')), /only support/);
	});
});
