import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { createPilotBundle } from "../lib/bundle.ts";
import { PILOT_BUNDLE_ENTRY_TYPE, restorePilotBundle, toPilotBundleEntry } from "../lib/bundle-session.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(root: string, name: string) {
	const common = path.join(root, `${name}.git`);
	const project = path.join(root, name);
	mkdirSync(common);
	mkdirSync(project);
	return { common, project };
}

function entry(bundle: ReturnType<typeof createPilotBundle>) {
	return { type: "custom", customType: PILOT_BUNDLE_ENTRY_TYPE, data: toPilotBundleEntry(bundle) };
}

describe("Pilot Bundle session restore", () => {
	test("restores only Bundles bound to the current cwd and Git common directory", () => {
		const root = mkdtempSync(path.join(tmpdir(), "pilot-bundle-session-"));
		roots.push(root);
		const first = workspace(root, "first");
		const second = workspace(root, "second");
		const firstBundle = createPilotBundle({
			gitCommonDir: first.common,
			cwd: first.project,
			originalPrompt: "First project task.",
			modePolicy: "edit",
			pilotActivation: "manual",
			effectiveRoute: "edit",
			runId: "first-run",
		});
		const secondBundle = createPilotBundle({
			gitCommonDir: second.common,
			cwd: second.project,
			originalPrompt: "Second project task.",
			modePolicy: "edit",
			pilotActivation: "manual",
			effectiveRoute: "edit",
			runId: "second-run",
		});

		assert.equal(restorePilotBundle([entry(firstBundle)], { cwd: first.project, gitCommonDir: first.common })?.manifest.runId, "first-run");
		assert.equal(restorePilotBundle([entry(firstBundle)], { cwd: second.project, gitCommonDir: second.common }), undefined);
		assert.equal(
			restorePilotBundle([entry(secondBundle), entry(firstBundle)], { cwd: second.project, gitCommonDir: second.common })?.manifest.runId,
			"second-run",
		);
	});
});
