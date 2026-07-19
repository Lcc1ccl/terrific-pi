import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIRED_AGENTS, loadDocsAgentProfiles, packageRoot, validateProfile } from "../lib/profiles.ts";

const root = packageRoot(fileURLToPath(import.meta.url));

describe("profiles", () => {
	test("loads four read-only agents", () => {
		const profiles = loadDocsAgentProfiles();
		assert.equal(profiles.length, REQUIRED_AGENTS.length);
		assert.deepEqual(profiles.flatMap(validateProfile), []);
	});
	test("ships skill and templates", () => {
		assert.ok(existsSync(path.join(root, "skills/project-docs/SKILL.md")));
		assert.ok(existsSync(path.join(root, "schemas/artifact-contract.json")));
	});
});
