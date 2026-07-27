import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	createAppearanceProfileReader,
	readAppearanceProfile,
} from "../lib/appearance-profile.ts";

function fixture(contents?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "statusline-profile-"));
	if (contents !== undefined) writeFileSync(join(dir, "terrific.json"), contents, "utf8");
	return dir;
}

describe("readAppearanceProfile", () => {
	const vectors: Array<[string, string | undefined, boolean, boolean]> = [
		["missing", undefined, false, false],
		["empty object", "{}", false, false],
		["exact profile", JSON.stringify({ appearance: { profile: "terrific-native-v1" } }), true, false],
		["off", JSON.stringify({ appearance: { profile: "off" } }), false, false],
		["unknown/non-string", JSON.stringify({ appearance: { profile: 1 } }), false, false],
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

	it("ignores a project terrific.json when the global profile is inactive", () => {
		const global = fixture("{}");
		const project = mkdtempSync(join(tmpdir(), "statusline-project-"));
		writeFileSync(join(project, "terrific.json"), JSON.stringify({ appearance: { profile: "terrific-native-v1" } }));
		assert.deepEqual(readAppearanceProfile(global), { active: false });
	});
});

it("caches the profile once per extension generation", () => {
	const dir = fixture("{}");
	const read = createAppearanceProfileReader(dir);
	assert.equal(read().active, false);
	writeFileSync(join(dir, "terrific.json"), JSON.stringify({ appearance: { profile: "terrific-native-v1" } }));
	assert.equal(read().active, false);
	assert.equal(createAppearanceProfileReader(dir)().active, true);
});
