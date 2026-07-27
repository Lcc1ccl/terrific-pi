import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { readTerrificNativeProfile } from "../lib/profile.ts";

const dirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "presentation-profile-"));
	dirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

function writeConfig(value: string): string {
	const dir = agentDir();
	writeFileSync(join(dir, "terrific.json"), value, "utf8");
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("global Terrific presentation profile", () => {
	it("is inactive when terrific.json is missing", () => {
		assert.deepEqual(readTerrificNativeProfile(agentDir()), { active: false });
	});

	it("is inactive for an empty object", () => {
		writeConfig("{}");
		assert.deepEqual(readTerrificNativeProfile(), { active: false });
	});

	it("activates only the exact native profile", () => {
		writeConfig(JSON.stringify({ appearance: { profile: "terrific-native-v1" } }));
		assert.deepEqual(readTerrificNativeProfile(), { active: true });
	});

	it("is inactive when explicitly off", () => {
		writeConfig(JSON.stringify({ appearance: { profile: "off" } }));
		assert.deepEqual(readTerrificNativeProfile(), { active: false });
	});

	it("is inactive for unknown and non-string profiles", () => {
		for (const profile of ["future", 1, null, true]) {
			writeConfig(JSON.stringify({ appearance: { profile } }));
			assert.deepEqual(readTerrificNativeProfile(), { active: false });
		}
	});

	it("fails closed when appearance is not an object", () => {
		writeConfig(JSON.stringify({ appearance: "on" }));
		const result = readTerrificNativeProfile();
		assert.equal(result.active, false);
		assert.match(result.error ?? "", /appearance/i);
	});

	it("fails closed on malformed JSON", () => {
		writeConfig("{");
		const result = readTerrificNativeProfile();
		assert.equal(result.active, false);
		assert.match(result.error ?? "", /parse|json/i);
	});

	it("ignores project-local activation and reads only PI_CODING_AGENT_DIR", () => {
		const global = writeConfig(JSON.stringify({ appearance: { profile: "off" } }));
		const project = mkdtempSync(join(tmpdir(), "presentation-profile-project-"));
		dirs.push(project);
		mkdirSync(join(project, ".pi"));
		writeFileSync(join(project, ".pi", "terrific.json"), JSON.stringify({ appearance: { profile: "terrific-native-v1" } }), "utf8");
		assert.equal(process.env.PI_CODING_AGENT_DIR, global);
		assert.deepEqual(readTerrificNativeProfile(), { active: false });
	});
});
