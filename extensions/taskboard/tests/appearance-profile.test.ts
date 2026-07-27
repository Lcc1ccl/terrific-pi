import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	createAppearanceProfileReader,
	readAppearanceProfile,
} from "../lib/appearance-profile.ts";

const dirs: string[] = [];

function fixture(contents?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "taskboard-profile-"));
	dirs.push(dir);
	if (contents !== undefined) writeFileSync(join(dir, "terrific.json"), contents, "utf8");
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("global Taskboard appearance profile", () => {
	const vectors: Array<[string, string | undefined, boolean, boolean]> = [
		["missing", undefined, false, false],
		["empty object", "{}", false, false],
		["exact profile", JSON.stringify({ appearance: { profile: "terrific-native-v1" } }), true, false],
		["off", JSON.stringify({ appearance: { profile: "off" } }), false, false],
		["unknown profile", JSON.stringify({ appearance: { profile: "future" } }), false, false],
		["non-string profile", JSON.stringify({ appearance: { profile: 1 } }), false, false],
		["appearance nonobject", JSON.stringify({ appearance: true }), false, true],
		["malformed JSON", "{", false, true],
	];

	for (const [name, contents, active, hasError] of vectors) {
		it(name, () => {
			const result = readAppearanceProfile(fixture(contents));
			assert.equal(result.active, active);
			assert.equal(Boolean(result.error), hasError);
		});
	}

	it("ignores project-local activation when the global profile is inactive", () => {
		const global = fixture("{}");
		const project = fixture();
		writeFileSync(join(project, "terrific.json"), JSON.stringify({
			appearance: { profile: "terrific-native-v1" },
		}), "utf8");
		const previousCwd = process.cwd();
		try {
			process.chdir(project);
			assert.deepEqual(readAppearanceProfile(global), { active: false });
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("reads PI_CODING_AGENT_DIR once per extension generation", () => {
		const dir = fixture("{}");
		const read = createAppearanceProfileReader(dir);
		assert.deepEqual(read(), { active: false });
		writeFileSync(join(dir, "terrific.json"), JSON.stringify({
			appearance: { profile: "terrific-native-v1" },
		}), "utf8");
		assert.deepEqual(read(), { active: false });
		assert.deepEqual(createAppearanceProfileReader(dir)(), { active: true });
	});
});
