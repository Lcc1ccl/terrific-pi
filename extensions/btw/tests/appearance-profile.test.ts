import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	createAppearanceProfileReader,
	readAppearanceProfile,
	withoutOwnedGlobalConfigWarning,
} from "../lib/appearance-profile.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "btw-appearance-"));
	roots.push(value);
	return value;
}

function write(agentDir: string, source: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "terrific.json"), source, "utf8");
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("global appearance profile", () => {
	it("covers the frozen eight-vector contract", () => {
		const cases: Array<{ source?: string; active: boolean; error: boolean }> = [
			{ active: false, error: false },
			{ source: "{}", active: false, error: false },
			{ source: JSON.stringify({ appearance: { profile: "terrific-native-v1" } }), active: true, error: false },
			{ source: JSON.stringify({ appearance: { profile: "off" } }), active: false, error: false },
			{ source: JSON.stringify({ appearance: { profile: "unknown" } }), active: false, error: false },
			{ source: JSON.stringify({ appearance: { profile: 1 } }), active: false, error: false },
			{ source: JSON.stringify({ appearance: [] }), active: false, error: true },
			{ source: "{bad", active: false, error: true },
		];
		for (const vector of cases) {
			const agentDir = root();
			if (vector.source !== undefined) write(agentDir, vector.source);
			const result = readAppearanceProfile(agentDir);
			assert.equal(result.active, vector.active);
			assert.equal(Boolean(result.error), vector.error);
		}

		const agentDir = root();
		const project = root();
		write(agentDir, "{}");
		write(join(project, ".pi"), JSON.stringify({ appearance: { profile: "terrific-native-v1" } }));
		assert.deepEqual(readAppearanceProfile(agentDir), { active: false });
	});

	it("uses PI_CODING_AGENT_DIR and caches once per generation", () => {
		const agentDir = root();
		write(agentDir, JSON.stringify({ appearance: { profile: "terrific-native-v1" } }));
		const previous = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const read = createAppearanceProfileReader();
			assert.deepEqual(read(), { active: true });
			write(agentDir, "{}");
			assert.deepEqual(read(), { active: true });
			assert.deepEqual(createAppearanceProfileReader()(), { active: false });
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});

	it("suppresses only the owned malformed global warning", () => {
		const agentDir = root();
		const global = `terrific-config: failed to read ${join(agentDir, "terrific.json")}: bad JSON`;
		const project = "terrific-config: failed to read /workspace/.pi/terrific.json: bad JSON";
		assert.deepEqual(withoutOwnedGlobalConfigWarning([global, project], { active: false, error: "bad JSON" }, agentDir), [project]);
		assert.deepEqual(withoutOwnedGlobalConfigWarning([global, project], { active: false }, agentDir), [global, project]);
	});
});
