import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const EXTENSIONS = [
	"./packages/interface/statusline/extensions/statusline.ts",
	"./packages/interface/appearance/extensions/appearance.ts",
	"./packages/interface/taskboard/extensions/taskboard.ts",
	"./packages/interface/presentation/extensions/presentation.ts",
	"./packages/session-control/mode/extensions/mode.ts",
	"./packages/session-control/fast/extensions/fast.ts",
	"./packages/session-control/context/extensions/context.ts",
	"./packages/session-control/model-profile/extensions/model-profile.ts",
	"./packages/runtime/auxiliary/extensions/auxiliary.ts",
	"./packages/runtime/btw/extensions/btw.ts",
];

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, "utf8"));
}

test("core root manifest exposes exactly the three approved domains", () => {
	const manifest = readJson(join(ROOT, "package.json"));
	assert.equal(manifest.name, "terrific-pi");
	assert.deepEqual(manifest.pi?.extensions, EXTENSIONS);
	assert.equal(manifest.pi?.skills, undefined);
	assert.equal(manifest.pi?.subagents, undefined);
	for (const relative of EXTENSIONS) {
		assert.equal(existsSync(join(ROOT, relative)), true, `missing resource: ${relative}`);
	}
});

test("npm tarball contains every declared extension entry", () => {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: ROOT,
		encoding: "utf8",
	});
	const packedPaths = new Set(JSON.parse(output)[0].files.map((file: { path: string }) => file.path));
	for (const entry of EXTENSIONS) {
		assert.equal(packedPaths.has(entry.replace(/^\.\//, "")), true, `missing from tarball: ${entry}`);
	}
});

test("component packages are private and retired distribution paths are absent", () => {
	for (const relative of EXTENSIONS) {
		const componentRoot = join(ROOT, relative, "..", "..");
		const manifest = readJson(join(componentRoot, "package.json"));
		assert.equal(manifest.private, true, `${componentRoot} must be private`);
	}
	for (const relative of [
		"extensions/pilot",
		"extensions/docsflow",
		"snapshot",
		"scripts/snapshot.sh",
		"scripts/pack.sh",
		"scripts/install.sh",
		"scripts/test-install.sh",
		"workflows",
	]) {
		assert.equal(existsSync(join(ROOT, relative)), false, `retired path remains: ${relative}`);
	}
});
